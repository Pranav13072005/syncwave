// In-memory room store. No database - rooms live only for the process
// lifetime, per MVP scope (no persistence required).
const uploadTokens = require('./uploadTokens');

const rooms = new Map(); // roomCode -> { code, hostId, clients, track, queue, readyDevices, nextReadyDevices, playback, emptyingTimer, playbackEndTimer, trackIdCounter } - see toPublicState() for the exact shape sent to clients

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const CODE_LENGTH = 5;
const PLAYBACK_SCHEDULE_LEAD_MS = 1000; // how far into the future play/pause/seek are scheduled
const COMPLETION_EPSILON_SEC = 0.05; // tolerance for floating-point "already at the end" comparisons
let ROOM_CLEANUP_GRACE_MS = 30_000; // how long an empty room survives before being deleted

// Test-only override so tests don't have to wait 30 real seconds to verify
// grace-period expiry. Never called from production code paths.
function setRoomCleanupGraceMsForTesting(ms) {
  ROOM_CLEANUP_GRACE_MS = ms;
}

let roomDeletedListener = null;

// Registers a callback invoked with the room object right after it's
// actually deleted (grace period expired while still empty). Used by
// index.js to delete the room's uploaded track file - roomManager.js
// deliberately knows nothing about the filesystem/UPLOAD_DIR.
function onRoomDeleted(listener) {
  roomDeletedListener = listener;
}

let playbackCompletedListener = null;

// Registers a callback invoked with the room object right after a track
// naturally completes (the server-side end timer fired and transitioned
// authoritative state to paused-at-duration). Used by index.js to broadcast
// the update - roomManager.js deliberately has no `io` access, same pattern
// as onRoomDeleted above.
function onPlaybackCompleted(listener) {
  playbackCompletedListener = listener;
}

function makeClientEntry(socketId, name) {
  return {
    id: socketId,
    name,
    rtt: null,
    clockOffsetMs: null,
    syncStatus: 'unsynced',
    driftMs: null,
    driftCorrectionCount: 0,
    joinedAt: Date.now(), // used to deterministically promote the longest-connected member on host disconnect
  };
}

function makeDefaultPlayback(version = 0) {
  return { status: 'paused', positionSec: 0, anchorServerTime: null, version, trackVersion: null };
}

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(hostSocketId, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    clients: new Map([[hostSocketId, makeClientEntry(hostSocketId, hostName)]]),
    track: null, // { trackId, version, originalName, mimeType, size, url, storedFilename, uploadedAt, durationSec? } - the current track
    queue: [], // [{ trackId, originalName, mimeType, size, url, storedFilename, uploadedAt, durationSec? }, ...] - upcoming tracks, queue[0] is the immediate-next preload candidate
    readyDevices: new Set(), // socketIds that have decoded room.track at its current version
    nextReadyDevices: new Set(), // socketIds that have decoded queue[0] at its current trackId - cleared whenever queue[0]'s identity changes
    playback: makeDefaultPlayback(),
    emptyingTimer: null,
    playbackEndTimer: null,
    trackIdCounter: 0, // assigns a stable trackId to every uploaded file (current or queued), independent of track.version's "current-slot generation" counter
  };
  rooms.set(code, room);
  return room;
}

// Assigns the next stable trackId for this room - a per-file identity that
// survives a track moving from queue to current (unlike track.version, which
// is a "how many times has the CURRENT slot been replaced" counter and
// intentionally bumps on that transition). Used to key next-track preload
// readiness so it can never be trusted for the wrong file.
function allocateTrackId(room) {
  room.trackIdCounter += 1;
  return room.trackIdCounter;
}

// Joining a room that's mid-grace-period (empty, pending cleanup) cancels
// that cleanup and restores it. If the room was empty, the first client to
// (re)join becomes host - there's no one else to defer to.
function joinRoom(roomCode, socketId, name) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'ROOM_NOT_FOUND' };
  const wasEmpty = room.clients.size === 0;
  if (room.emptyingTimer) {
    clearTimeout(room.emptyingTimer);
    room.emptyingTimer = null;
  }
  room.clients.set(socketId, makeClientEntry(socketId, name));
  if (wasEmpty) {
    room.hostId = socketId;
  }
  return { room };
}

// Deterministically promotes the longest-connected remaining client (lowest
// joinedAt) to host, or clears hostId if no one remains.
function promoteNewHost(room) {
  let longestConnected = null;
  for (const client of room.clients.values()) {
    if (!longestConnected || client.joinedAt < longestConnected.joinedAt) {
      longestConnected = client;
    }
  }
  room.hostId = longestConnected ? longestConnected.id : null;
}

// Starts (or no-ops if already running) the grace-period cleanup timer for
// an empty room. unref()'d so a live server process can still exit cleanly
// and so test runs don't hang waiting on it.
function scheduleRoomCleanup(room) {
  if (room.emptyingTimer) return;
  const timer = setTimeout(() => {
    room.emptyingTimer = null;
    // Re-check both conditions: someone may have rejoined (joinRoom already
    // clears emptyingTimer in that case, but this guards any other race),
    // and the room might already be a *different* object at this code if a
    // same-named room code were ever reused (defensive, not expected).
    if (room.clients.size === 0 && rooms.get(room.code) === room) {
      cancelEndTimer(room); // make sure a pending completion timer never leaks past deletion
      rooms.delete(room.code);
      uploadTokens.purgeRoom(room.code);
      roomDeletedListener?.(room);
    }
  }, ROOM_CLEANUP_GRACE_MS);
  timer.unref?.();
  room.emptyingTimer = timer;
}

function isPendingCleanup(room) {
  return !!(room && room.emptyingTimer);
}

// Removes a socket from whatever room it's in. If it was the host, a new
// host is deterministically promoted (longest-connected remaining member) -
// see promoteNewHost. If the room becomes empty, cleanup is scheduled with a
// grace period rather than deleting immediately (see scheduleRoomCleanup).
// Returns the affected room (for broadcasting), or null if the socket wasn't
// in any room, or if the room is now empty (nothing left to broadcast to).
function leaveRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.clients.has(socketId)) {
      room.clients.delete(socketId);
      room.readyDevices.delete(socketId);
      room.nextReadyDevices.delete(socketId);
      if (room.hostId === socketId) {
        promoteNewHost(room);
      }
      if (room.clients.size === 0) {
        scheduleRoomCleanup(room);
        return null;
      }
      return room;
    }
  }
  return null;
}

function getRoom(roomCode) {
  return rooms.get(roomCode) || null;
}

// Finds whichever room a socket currently belongs to (used by handlers that
// only know the socket, not the room code).
function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.clients.has(socketId)) return room;
  }
  return null;
}

// Replaces the room's current track, bumping its version and clearing all
// READY state - clients must re-decode and re-confirm ready for the new
// track. Also resets playback to paused/0 and bumps the playback version,
// so any in-flight play/pause/seek scheduled for the superseded track is
// naturally rejected by clients' playback-version staleness check too.
// Cancels any pending natural-completion timer - it belonged to the old
// track and must never fire against the new one.
// Returns the previous track (if any) so its file can be cleaned up.
function setTrack(roomCode, meta) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const previousTrack = room.track;
  const version = previousTrack ? previousTrack.version + 1 : 1;
  const trackId = allocateTrackId(room);
  room.track = { trackId, version, ...meta };
  room.readyDevices = new Set();
  room.playback = makeDefaultPlayback(room.playback.version + 1);
  room.playback.trackVersion = version;
  cancelEndTimer(room);
  return { room, previousTrack };
}

// Appends an uploaded track to the queue (used by uploadRoute.js when a
// current track already exists - the same upload/token authorization path,
// just a different destination slot). Does NOT touch current track/playback
// state at all - queue-only mutations must never disturb active playback.
// If the queue was empty, queue[0]'s identity just changed (null -> this
// track), so any stale nextReadyDevices from a since-cleared queue is reset.
function addToQueue(roomCode, meta) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const trackId = allocateTrackId(room);
  const wasEmpty = room.queue.length === 0;
  const queuedTrack = { trackId, ...meta };
  room.queue.push(queuedTrack);
  if (wasEmpty) {
    room.nextReadyDevices = new Set();
  }
  return { room, queuedTrack };
}

// Removes a queued track by its stable trackId (host-only, enforced by the
// caller). Deliberately queue-only - can never touch room.track, since a
// track that's already current isn't in room.queue at all. If the removed
// track was queue[0] (the immediate-next candidate), its identity just
// changed, so stale readiness reports for it must be discarded.
function removeFromQueue(roomCode, trackId) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'NO_ROOM' };
  const idx = room.queue.findIndex((t) => t.trackId === trackId);
  if (idx === -1) return { error: 'TRACK_NOT_FOUND' };
  const wasNext = idx === 0;
  const [removedTrack] = room.queue.splice(idx, 1);
  if (wasNext) {
    room.nextReadyDevices = new Set();
  }
  return { room, removedTrack };
}

// Moves a queued track to a new index (host-only, enforced by the caller).
// toIndex is clamped into range rather than rejected - a UI move-up/move-down
// button can't send an out-of-range index anyway, and clamping is simpler
// than a second error case for what's really just "stay in bounds". Queue-only,
// same as removeFromQueue - never touches current track/playback. Resets
// nextReadyDevices only if queue[0]'s identity actually changed as a result
// (e.g. reordering items #2 and #3 leaves the immediate-next candidate alone).
function reorderQueue(roomCode, trackId, toIndex) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'NO_ROOM' };
  const fromIndex = room.queue.findIndex((t) => t.trackId === trackId);
  if (fromIndex === -1) return { error: 'TRACK_NOT_FOUND' };
  if (typeof toIndex !== 'number' || !Number.isFinite(toIndex)) return { error: 'INVALID_INDEX' };
  const clampedToIndex = Math.max(0, Math.min(Math.trunc(toIndex), room.queue.length - 1));
  const beforeNextTrackId = room.queue[0]?.trackId ?? null;
  const [item] = room.queue.splice(fromIndex, 1);
  room.queue.splice(clampedToIndex, 0, item);
  const afterNextTrackId = room.queue[0]?.trackId ?? null;
  if (beforeNextTrackId !== afterNextTrackId) {
    room.nextReadyDevices = new Set();
  }
  return { room };
}

// Marks a socket as ready for the immediate-next queued track (queue[0]),
// mirroring setReady's pattern for the current track. Rejects (no-op,
// returns null) if the reported trackId doesn't match queue[0] EXACTLY -
// protects against a stale preload completion (for a track that's since been
// removed/reordered/replaced as the next candidate) ever being trusted.
// durationSec is stored on the queue item so it can carry forward into
// room.track.durationSec (and arm the end timer immediately) if this track
// becomes current via advanceToNextTrack before a fresh track:ready arrives.
function setNextReady(socketId, trackId, durationSec) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;
  const nextTrack = room.queue[0];
  if (!nextTrack || nextTrack.trackId !== trackId) return null;
  room.nextReadyDevices.add(socketId);
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
    nextTrack.durationSec = durationSec;
  }
  return room;
}

// Shared by manual Next and automatic natural-completion advance: shifts
// queue[0] into room.track (a track replacement, same as setTrack - bumps
// track.version, clears readyDevices) and starts it playing from 0 at a
// future targetServerTime via the SAME scheduling lead every other playback
// command uses (no separate "transition" lead - a short, server-broadcast
// gap is acceptable per spec; sample-perfect gapless playback is explicitly
// out of scope). Cancels the old track's end timer first (it must never fire
// for the new track) and schedules a fresh one for the new track via the
// normal scheduleEndTimer path - which is how the completion chain advances
// through multiple queued tracks with no extra bookkeeping.
function advanceToNextTrack(room) {
  cancelEndTimer(room);
  const previousTrack = room.track;
  const nextTrack = room.queue.shift();
  const version = previousTrack ? previousTrack.version + 1 : 1;
  room.track = { ...nextTrack, version };
  room.readyDevices = new Set();
  room.nextReadyDevices = new Set(); // queue[0] is now a different track (or the queue is empty)
  const targetServerTime = Date.now() + PLAYBACK_SCHEDULE_LEAD_MS;
  room.playback = {
    status: 'playing',
    positionSec: 0,
    anchorServerTime: targetServerTime,
    version: room.playback.version + 1,
    trackVersion: version,
  };
  scheduleEndTimer(room);
  return { room, targetServerTime, previousTrack };
}

// Host-only Next (authorization enforced by the caller). Rejects QUEUE_EMPTY
// without disturbing current playback at all if there's nothing queued.
function issueNextCommand(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'NO_ROOM' };
  if (room.queue.length === 0) return { error: 'QUEUE_EMPTY' };
  return advanceToNextTrack(room);
}

// Marks a socket as READY for a specific track version. Rejects (no-op) if
// the socket isn't in a room, there's no current track, or the version is
// stale - protects against a slow decode finishing after the track changed.
// durationSec (from the client's decoded AudioBuffer) is stored on the track
// so the server can validate seek positions against the real track length.
// If duration just became known for the first time while already playing,
// the natural-completion timer (which couldn't be scheduled without a known
// duration) is scheduled now - covers the host pressing Play before their
// own device finishes decoding.
function setReady(socketId, version, durationSec) {
  const room = findRoomBySocket(socketId);
  if (!room || !room.track || room.track.version !== version) return null;
  room.readyDevices.add(socketId);
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
    const durationWasUnknown = room.track.durationSec == null;
    room.track.durationSec = durationSec;
    if (durationWasUnknown && room.playback.status === 'playing') {
      scheduleEndTimer(room);
    }
  }
  return room;
}

// Canonical playback position at a given server timestamp (defaults to now).
// Paused: position is frozen. Playing: extrapolated forward from the anchor,
// clamped so a timestamp before the anchor (e.g. a command that lands before
// a still-pending scheduled play) doesn't produce a negative elapsed time.
// Always clamped to [0, track.durationSec] once duration is known - the
// canonical timeline must never report/act on a position past the end of
// the track, regardless of how long "playing" has been extrapolated for.
function getCanonicalPosition(room, atServerTime = Date.now()) {
  const pb = room.playback;
  let positionSec;
  if (pb.status !== 'playing' || pb.anchorServerTime === null) {
    positionSec = pb.positionSec;
  } else {
    const elapsedSec = Math.max(0, (atServerTime - pb.anchorServerTime) / 1000);
    positionSec = pb.positionSec + elapsedSec;
  }
  return clampToDuration(positionSec, room.track?.durationSec);
}

function clampToDuration(positionSec, durationSec) {
  let clamped = Math.max(0, positionSec);
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec >= 0) {
    clamped = Math.min(clamped, durationSec);
  }
  return clamped;
}

// Cancels a room's pending natural-completion timer, if any.
function cancelEndTimer(room) {
  if (room.playbackEndTimer) {
    clearTimeout(room.playbackEndTimer);
    room.playbackEndTimer = null;
  }
}

function hasActiveEndTimer(room) {
  return !!(room && room.playbackEndTimer);
}

// Schedules (replacing any existing one) the server-side timer that
// transitions playback to paused-at-duration when the track naturally
// finishes. No-ops (after cancelling any stale timer) if not currently
// playing or the track's duration isn't known yet - setReady schedules it
// retroactively once duration becomes known while playing.
//
// The timer captures the playback version and track version it was
// scheduled for. When it fires, it only completes playback if the room
// still exists AND both versions still match exactly - an intervening
// Play/Pause/Seek/track-replacement (all of which bump playback.version)
// makes a stale timer a safe no-op instead of corrupting newer state.
function scheduleEndTimer(room) {
  cancelEndTimer(room);
  const durationSec = room.track?.durationSec;
  if (
    room.playback.status !== 'playing' ||
    room.playback.anchorServerTime === null ||
    typeof durationSec !== 'number' ||
    !Number.isFinite(durationSec)
  ) {
    return;
  }
  const remainingSec = durationSec - room.playback.positionSec;
  const endServerTime = room.playback.anchorServerTime + remainingSec * 1000;
  const delayMs = Math.max(0, endServerTime - Date.now());
  const expectedPlaybackVersion = room.playback.version;
  const expectedTrackVersion = room.track.version;

  const timer = setTimeout(() => {
    room.playbackEndTimer = null;
    if (rooms.get(room.code) !== room) return; // room deleted/replaced
    if (room.playback.version !== expectedPlaybackVersion) return; // superseded by a newer command
    if (room.track?.version !== expectedTrackVersion) return; // track replaced
    if (room.playback.status !== 'playing') return; // defensive - implied by the version check above
    completeNaturalPlayback(room);
  }, delayMs);
  timer.unref?.();
  room.playbackEndTimer = timer;
}

// Transitions authoritative playback when a track naturally reaches its
// duration, and notifies the registered listener (server/index.js broadcasts
// room:update from it, and cleans up the superseded file if one was
// replaced). If the queue has a next track, performs one clean
// advanceToNextTrack (Phase 6.2A) instead of ever broadcasting a permanent
// paused-at-end state first - a queued room never stops on natural
// completion, it flows straight into the next track. If the queue is empty,
// this is exactly the Phase 6.1 behavior: pauses at positionSec = duration.
// Either way, playback.version is bumped like every other authoritative
// state change, so clients' existing stale-version protection applies here too.
function completeNaturalPlayback(room) {
  if (room.queue.length > 0) {
    const { previousTrack } = advanceToNextTrack(room);
    playbackCompletedListener?.(room, { previousTrack });
    return room;
  }
  const durationSec = room.track.durationSec;
  room.playback = {
    status: 'paused',
    positionSec: durationSec,
    anchorServerTime: Date.now(),
    version: room.playback.version + 1,
    trackVersion: room.track.version,
  };
  playbackCompletedListener?.(room, {});
  return room;
}

function issuePlayCommand(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'NO_ROOM' };
  if (!room.track) return { error: 'NO_TRACK' };
  const targetServerTime = Date.now() + PLAYBACK_SCHEDULE_LEAD_MS;
  let positionSec = getCanonicalPosition(room, targetServerTime);
  const durationSec = room.track.durationSec;
  // If we're already at (or within a tiny floating-point epsilon of) the
  // natural end of the track, Play restarts from the beginning instead of
  // trying to start an AudioBufferSourceNode at/past its own duration.
  const atEnd = typeof durationSec === 'number' && Number.isFinite(durationSec) && positionSec >= durationSec - COMPLETION_EPSILON_SEC;
  if (atEnd) {
    positionSec = 0;
  }
  room.playback = {
    status: 'playing',
    positionSec,
    anchorServerTime: targetServerTime,
    version: room.playback.version + 1,
    trackVersion: room.track.version,
  };
  scheduleEndTimer(room);
  return { room, targetServerTime };
}

function issuePauseCommand(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'NO_ROOM' };
  if (!room.track) return { error: 'NO_TRACK' };
  const targetServerTime = Date.now() + PLAYBACK_SCHEDULE_LEAD_MS;
  const positionSec = getCanonicalPosition(room, targetServerTime);
  room.playback = {
    status: 'paused',
    positionSec,
    anchorServerTime: targetServerTime,
    version: room.playback.version + 1,
    trackVersion: room.track.version,
  };
  cancelEndTimer(room);
  return { room, targetServerTime };
}

function issueSeekCommand(roomCode, positionSec) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'NO_ROOM' };
  if (!room.track) return { error: 'NO_TRACK' };
  if (typeof positionSec !== 'number' || !Number.isFinite(positionSec) || positionSec < 0) {
    return { error: 'INVALID_SEEK_POSITION' };
  }
  if (typeof room.track.durationSec === 'number' && positionSec > room.track.durationSec) {
    return { error: 'SEEK_OUT_OF_RANGE' };
  }
  const targetServerTime = Date.now() + PLAYBACK_SCHEDULE_LEAD_MS;
  room.playback = {
    status: room.playback.status, // seek preserves playing/paused
    positionSec,
    anchorServerTime: targetServerTime,
    version: room.playback.version + 1,
    trackVersion: room.track.version,
  };
  if (room.playback.status === 'playing') {
    scheduleEndTimer(room); // replaces the old timer with one reflecting the new remaining duration
  } else {
    cancelEndTimer(room);
  }
  return { room, targetServerTime };
}

// Stores a client's latest self-reported clock-sync result (from
// client/src/clockSync.js via the `clock:report` event). Purely
// informational for diagnostics - never used to derive authoritative state.
function updateClientDiagnostics(socketId, { rtt, offsetMs, status }) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;
  const client = room.clients.get(socketId);
  if (!client) return null;
  client.rtt = rtt;
  client.clockOffsetMs = offsetMs;
  client.syncStatus = status;
  return room;
}

// Stores a client's latest self-reported playback-drift measurement (Phase 5,
// client/src/driftMonitor.js via the `playback:driftReport` event). Purely
// informational for diagnostics - never used to derive authoritative state,
// same policy as updateClientDiagnostics above.
function updatePlaybackDiagnostics(socketId, { driftMs, correctionCount }) {
  const room = findRoomBySocket(socketId);
  if (!room) return null;
  const client = room.clients.get(socketId);
  if (!client) return null;
  client.driftMs = driftMs;
  client.driftCorrectionCount = correctionCount;
  return room;
}

// isHost is computed here (not stored per-client) so host reassignment
// (Phase 6) can never leave a stale isHost flag lying around on some other
// client entry - there is exactly one source of truth, room.hostId.
function toPublicState(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    track: room.track,
    queue: room.queue,
    playback: room.playback,
    clients: Array.from(room.clients.values()).map((c) => ({
      ...c,
      isHost: c.id === room.hostId,
      isReady: room.readyDevices.has(c.id),
      isNextReady: room.nextReadyDevices.has(c.id),
    })),
  };
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  findRoomBySocket,
  setTrack,
  addToQueue,
  removeFromQueue,
  reorderQueue,
  setReady,
  setNextReady,
  advanceToNextTrack,
  issueNextCommand,
  updateClientDiagnostics,
  updatePlaybackDiagnostics,
  getCanonicalPosition,
  issuePlayCommand,
  issuePauseCommand,
  issueSeekCommand,
  toPublicState,
  isPendingCleanup,
  onRoomDeleted,
  setRoomCleanupGraceMsForTesting,
  onPlaybackCompleted,
  hasActiveEndTimer,
};

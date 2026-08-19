// In-memory room store. No database - rooms live only for the process
// lifetime, per MVP scope (no persistence required).
const uploadTokens = require('./uploadTokens');

const rooms = new Map(); // roomCode -> { code, hostId, clients, track, readyDevices, playback, emptyingTimer } - see toPublicState() for the exact shape sent to clients

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const CODE_LENGTH = 5;
const PLAYBACK_SCHEDULE_LEAD_MS = 1000; // how far into the future play/pause/seek are scheduled
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
    track: null, // { version, originalName, mimeType, size, url, storedFilename, uploadedAt, durationSec? }
    readyDevices: new Set(), // socketIds that have decoded room.track at its current version
    playback: makeDefaultPlayback(),
    emptyingTimer: null,
  };
  rooms.set(code, room);
  return room;
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
// Returns the previous track (if any) so its file can be cleaned up.
function setTrack(roomCode, meta) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const previousTrack = room.track;
  const version = previousTrack ? previousTrack.version + 1 : 1;
  room.track = { version, ...meta };
  room.readyDevices = new Set();
  room.playback = makeDefaultPlayback(room.playback.version + 1);
  room.playback.trackVersion = version;
  return { room, previousTrack };
}

// Marks a socket as READY for a specific track version. Rejects (no-op) if
// the socket isn't in a room, there's no current track, or the version is
// stale - protects against a slow decode finishing after the track changed.
// durationSec (from the client's decoded AudioBuffer) is stored on the track
// so the server can validate seek positions against the real track length.
function setReady(socketId, version, durationSec) {
  const room = findRoomBySocket(socketId);
  if (!room || !room.track || room.track.version !== version) return null;
  room.readyDevices.add(socketId);
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
    room.track.durationSec = durationSec;
  }
  return room;
}

// Canonical playback position at a given server timestamp (defaults to now).
// Paused: position is frozen. Playing: extrapolated forward from the anchor,
// clamped so a timestamp before the anchor (e.g. a command that lands before
// a still-pending scheduled play) doesn't produce a negative elapsed time.
function getCanonicalPosition(room, atServerTime = Date.now()) {
  const pb = room.playback;
  if (pb.status !== 'playing' || pb.anchorServerTime === null) return pb.positionSec;
  const elapsedSec = Math.max(0, (atServerTime - pb.anchorServerTime) / 1000);
  return pb.positionSec + elapsedSec;
}

function issuePlayCommand(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'NO_ROOM' };
  if (!room.track) return { error: 'NO_TRACK' };
  const targetServerTime = Date.now() + PLAYBACK_SCHEDULE_LEAD_MS;
  const positionSec = getCanonicalPosition(room, targetServerTime);
  room.playback = {
    status: 'playing',
    positionSec,
    anchorServerTime: targetServerTime,
    version: room.playback.version + 1,
    trackVersion: room.track.version,
  };
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
    playback: room.playback,
    clients: Array.from(room.clients.values()).map((c) => ({
      ...c,
      isHost: c.id === room.hostId,
      isReady: room.readyDevices.has(c.id),
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
  setReady,
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
};

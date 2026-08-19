# SyncWave — Project Context

## Goal
Real-time multi-device synchronized audio playback web app. A host creates a
room, devices join and preload the same uploaded audio track, host controls
play/pause/seek, and playback stays synchronized across devices via
server-authoritative state, clock-offset estimation, future-scheduled Web
Audio playback, and periodic drift correction. Not a live-streaming app —
audio is fully downloaded/decoded on each device before playback.

## Stack
- Frontend: React.js (Vite 5 + @vitejs/plugin-react, plain JS not TS) — `client/`, dev server on :5173 (or next free port), proxies `/socket.io` to the backend.
- Backend: Node.js + Express.js — `server/`, listens on :3001.
- Real-time: Socket.IO
- Audio: Web Audio API (AudioBufferSourceNode scheduling)
- Uploads: Multer 2.x — `server/uploadRoute.js`, files stored locally under `server/uploads/` (gitignored, `.gitkeep` tracked).

## Architecture
Server is authoritative for room and playback state. Clients never decide
playback state independently — they only convert server-issued timestamps
into local scheduling.

## Room-state model
Implemented in `server/roomManager.js` (in-memory `Map<roomCode, room>`, no
persistence). Current shape:
```
{
  code, hostId,
  coHostIds: Set<socketId>,  // Phase 6.2B: delegated control (play/pause/seek/next/queue), distinct from the single primary hostId
  clients: Map<socketId, {id, name, rtt, clockOffsetMs, syncStatus, driftMs, driftCorrectionCount, joinedAt}>,
  track: null | { trackId, version, originalName, mimeType, size, url, storedFilename, uploadedAt, durationSec? },
  queue: [{ trackId, originalName, mimeType, size, url, storedFilename, uploadedAt, durationSec? }, ...],  // queue[0] is the immediate-next preload candidate
  readyDevices: Set<socketId>,  // devices that decoded `track` at its current version
  nextReadyDevices: Set<socketId>,  // devices that decoded queue[0] at its current trackId
  playback: { status: 'playing'|'paused', positionSec, anchorServerTime, version, trackVersion },
  emptyingTimer: Timeout | null,  // Phase 6: set while the room is empty and mid-grace-period
  playbackEndTimer: Timeout | null,  // set while playing with a known duration - fires natural completion (or, Phase 6.2A, a queue advance)
  trackIdCounter: number,  // Phase 6.2A: assigns each uploaded file (current or queued) a stable identity, separate from track.version
}
```
`trackId` (Phase 6.2A) vs. `track.version`: these answer two different questions and are
deliberately NOT unified into one counter. `track.version` is "how many times has the
CURRENT-track slot been replaced" - it's what `playback.trackVersion` ties to, and what the
existing `readyDevices` staleness check (`track:ready`) is keyed on; it intentionally bumps
every time a track becomes current, including when a queued track advances into that slot.
`trackId` is "which physical uploaded file is this" - a per-room monotonic counter assigned
once at upload time (whether the file becomes current immediately or is queued) that stays
unchanged as that same file later moves from `queue` into `track`. It exists specifically so
next-track preload readiness (`nextReadyDevices`, `queue:trackReady`) can be validated against
"is this a report for queue[0], right now" without a new parallel version-counter family - see
"Queue + preload + synchronized transitions" below.
`isHost` is NOT stored per-client (Phase 6 removed it from the client record) -
it's computed in `toPublicState()` as `c.id === room.hostId`, so host
reassignment can never leave a stale flag on some other client. `joinedAt`
(Phase 6, `Date.now()` at join time) is used to deterministically pick the
longest-connected remaining member to promote on host disconnect.
`isCoHost` (Phase 6.2B, same pattern) is likewise computed, never stored -
`c.id === room.hostId ? computed isHost : room.coHostIds.has(c.id)`. Role
management (`promoteToCoHost`/`demoteToParticipant`/`transferPrimaryHost` in
`roomManager.js`) is primary-host-only, enforced by `socketUtils.js`'s
`requireHost` (strict, primary-only) vs. `requireController` (primary OR
co-host - used for playback/queue commands, which co-hosts may issue).
Host-disconnect failover (`promoteNewHost`) now prefers the longest-connected
remaining CO-HOST, falling back to the longest-connected member of any role
only if no co-host remains - with zero co-hosts ever created (every
pre-Phase-6.2B room), this is identical to the original rule.
`driftMs`/`driftCorrectionCount` (Phase 5) default `null`/`0` until the client
reports a drift measurement via `playback:driftReport` - purely informational,
same policy as `rtt`/`clockOffsetMs`.
`rtt`/`clockOffsetMs` default `null` and `syncStatus` defaults `'unsynced'` until
the client reports a clock-sync result (Phase 3, `clock:report`).
`track.durationSec` is set once any client reports it via `track:ready`
(Phase 4) — absent until then.
`playback` (Phase 4, `server/roomManager.js`): `anchorServerTime` is the server
timestamp `positionSec` is anchored to — for `'playing'` it's when to start
(canonical position extrapolates forward from it); for `'paused'` it's when to
stop (position is frozen). It doubles as the client's scheduling target, so
there's no separate `targetServerTime` field. `version` is a single monotonic
counter bumped by every play/pause/seek AND by track replacement (so a
superseded command is always version-rejected, whether superseded by another
command or by a new upload). `trackVersion` ties the playback state to the
`track.version` it applies to — a client must never apply a playback update
for a track version it hasn't decoded.
Public form sent to clients (`toPublicState`): `{ roomCode, hostId, track, playback, clients: [{id, name, isHost, isReady, rtt, clockOffsetMs, syncStatus}] }`.

## Socket-event contract
Phase 0 PoC events (still live, untouched, served at `server/public/*`):
- `clock:ping` (client→server, ack) — `clientSendTime` in, `{ serverTime, clientSendTime }` ack out.
- `poc:requestPlay` (client→server) — any client may trigger; no host concept.
- `poc:scheduledPlay` (server→all clients) — `{ targetServerTime, startOffsetSec }`.

Phase 1 room events (real app, `server/roomHandlers.js` + `client/src/components/*`):
- `room:create` (client→server, ack) — `{ name }` in, ack `{ ok, state }` where `state = { roomCode, hostId, clients }`. Creator becomes host.
- `room:join` (client→server, ack) — `{ roomCode, name }` in, ack `{ ok, state }` or `{ ok: false, error: 'ROOM_NOT_FOUND' }`. Also reused (Phase 6, unchanged signature) for reconnect rejoin - `client/src/components/Room.jsx` calls it again on the Socket.IO `reconnect` event using the room code/name remembered from the original join. If the room is mid-grace-period (empty, pending cleanup), joining cancels the cleanup and restores it; if the room was empty, the joiner becomes host.
- `room:leave` (client→server, ack) — no payload; ack `{ ok: true }`. Also triggered implicitly by socket `disconnect`.
- `room:update` (server→room) — broadcast to all sockets in the room whenever membership, host, track, or ready state changes; full `state` payload (not a diff).

Phase 2 track events (`server/trackHandlers.js`, `server/uploadRoute.js`, `client/src/audioEngine.js` + `TrackPanel.jsx`):
- `track:requestUploadToken` (client→server, ack) — no payload; ack `{ ok: true, token }` only if the requesting socket is the room's current host, else `{ ok: false, error: 'NOT_HOST' | 'NO_ROOM' }`. Token is single-use, 30s TTL (`server/uploadTokens.js`).
- `POST /api/upload` (HTTP, not a socket event) — header `x-upload-token`, multipart field `file` (Multer, disk storage, 25MB limit, `.mp3`/`.wav` extension filter). Requires a valid token from the step above. On success, updates the room's track (bumping `track.version`, clearing `readyDevices`), deletes the previous track's file, responds `{ ok: true, track }`, and broadcasts `room:update`. Errors: `403 INVALID_TOKEN`, `400 INVALID_FILE_TYPE`, `413 FILE_TOO_LARGE`, `400 NO_FILE`, `404 ROOM_NOT_FOUND`.
- `GET /uploads/<storedFilename>` — static file serving of the current/past uploaded tracks.
- `track:ready` (client→server, ack) — `{ version }` in; only accepted if it matches the room's current `track.version` (stale acks from a slow decode of a superseded track are silently ignored). On success, adds the socket to `readyDevices` and broadcasts `room:update`.

Phase 3 clock-sync events (`client/src/clockSync.js`, `client/src/components/Diagnostics.jsx`, `server/clockHandlers.js`):
- `clock:ping` (client→server, ack) — unchanged from Phase 0; now also the low-level primitive the Phase 3 protocol samples 9 times per sync round.
- `clock:report` (client→server, ack) — `{ rtt, offsetMs, status }` in (the client's own robust estimate); ack `{ ok }`. Stores the result on the reporting client's room entry and broadcasts `room:update`; `{ ok: false }` (no-op) if the socket isn't currently in a room. Since Phase 6, this is only a brief window during reconnect (before `Room.jsx`'s rejoin completes), not a lasting gap.

Phase 4 playback events (`server/playbackHandlers.js`, `client/src/playbackEngine.js` + `PlaybackControls.jsx`):
- `playback:play` (client→server, ack) — no payload. Host-only. Resumes from the current canonical position (whatever it is) at a future `targetServerTime`; ack `{ ok: false, error: 'NOT_HOST' | 'NO_ROOM' | 'NO_TRACK' }` on rejection.
- `playback:pause` (client→server, ack) — no payload. Host-only. Freezes the canonical position (extrapolated to the future target time) at a future `targetServerTime`.
- `playback:seek` (client→server, ack) — `{ positionSec }` in. Host-only. Sets the canonical position at a future `targetServerTime`, preserving whatever the current status was. Rejects `INVALID_SEEK_POSITION` (non-finite/negative) or `SEEK_OUT_OF_RANGE` (beyond the track's known `durationSec`, once reported).
- All three broadcast the updated state via the existing `room:update` (not a separate event — see "Important decisions" for why) with the new `playback` object, which clients apply only if `playback.version` is strictly newer than the last version they applied.
- `track:ready` (extended from Phase 2) now also accepts `durationSec` (the decoded `AudioBuffer.duration`), stored on `room.track.durationSec` (overwritten by each reporting client - harmless since all clients decode the same file) - enables real seek-range validation.

Phase 5 drift events (`server/driftHandlers.js`, `client/src/driftMonitor.js` + `Room.jsx`):
- `playback:driftReport` (client→server, ack) — `{ driftMs, correctionCount }` in (this client's latest self-measured drift and cumulative correction count for the current track); ack `{ ok }`. Stores it on the reporting client's room entry and broadcasts `room:update`, same no-op-if-no-room policy as `clock:report`. Purely informational, never used to derive authoritative state.

Phase 6 recovery (no new socket events - reuses `room:join`/`room:update` as noted above; the new mechanism lives in `client/src/recoveryState.js`, `server/roomManager.js`'s promotion/cleanup logic, and `server/uploadRoute.js`'s host re-check):
- `POST /api/upload` gained one more rejection: after consuming the token, the route re-checks that the token's `socketId` is *still* the room's current `hostId` (not just at token-issue time). A former host's already-issued-but-unused token now fails with the same `403 INVALID_TOKEN` once host ownership has changed.

Phase 6.2A queue events (`server/queueHandlers.js`, `client/src/components/QueuePanel.jsx` + `Room.jsx`'s preload effect):
- `POST /api/upload` behavior change: the SAME upload/token flow now branches on whether the room already has a current track. No current track -> the upload becomes current (unchanged from Phase 2). A current track already exists -> the upload is appended to `room.queue` instead of replacing it - **uploads no longer replace a track that's already playing.** Response now also includes `queuedTrack` when that branch is taken. There is deliberately no separate `queue:add` socket event - adding to the queue reuses the exact same upload-token/host-authorization mechanism as any other upload, just routed to a different destination slot server-side.
- `queue:remove` (client→server, ack) - `{ trackId }` in. Host-only. Removes a queued track by its stable `trackId`; ack `{ ok: false, error: 'NOT_HOST' | 'NO_ROOM' | 'TRACK_NOT_FOUND' }` on rejection. Never touches `room.track` (a current track isn't in `room.queue`, so it can't be targeted this way). The removed file is deleted from disk once no longer referenced.
- `queue:reorder` (client→server, ack) - `{ trackId, toIndex }` in. Host-only. Moves a queued track to `toIndex` (clamped into range rather than rejected). Never touches current track/playback state.
- `queue:next` (client→server, ack) - no payload. Host-only. Rejects `QUEUE_EMPTY` (current playback left completely undisturbed) if nothing is queued; otherwise atomically shifts `queue[0]` into `room.track` and starts it playing from `positionSec: 0` at a future `anchorServerTime` - the same `PLAYBACK_SCHEDULE_LEAD_MS` (1000ms) lead every other playback command uses, not a new constant.
- `queue:trackReady` (client→server, ack) - `{ trackId, durationSec }` in; only accepted if `trackId` matches `queue[0]` EXACTLY right now (a report for any other track - stale after a reorder/removal/advance - is silently ignored, mirroring `track:ready`'s version check). On success, adds the socket to `nextReadyDevices` and stores `durationSec` on the queue item so it carries forward into `room.track.durationSec` (arming the end timer immediately) if/when this track becomes current before a fresh `track:ready` arrives.
- All four broadcast the updated state via the existing `room:update` (not a new event), same as every other room-state change since Phase 1. `toPublicState` now also includes `queue`, and each client entry gains `isNextReady` (mirrors the existing `isReady`).

Phase 6.2A.1 reliability fixes (no new socket events - client-only fixes, see the Synchronization algorithm section below for the mechanisms):
- `playback:play`/`pause`/`seek` and `queue:next`/`remove`/`reorder` now authorize via `requireController` (primary host OR co-host) instead of the old `requireHost` (primary-only) - a forward-looking change made alongside the co-host work in the same pass, since both touched the same authorization layer.

Phase 6.2B role events (`server/roleHandlers.js`, PRIMARY-HOST-ONLY - `requireHost`, not `requireController`):
- `room:promoteCoHost` (client→server, ack) - `{ targetSocketId }` in. Adds the target to `coHostIds`; ack `{ ok: false, error: 'NOT_HOST' | 'NO_ROOM' | 'TARGET_NOT_IN_ROOM' | 'ALREADY_PRIMARY_HOST' }` on rejection.
- `room:demoteCoHost` (client→server, ack) - `{ targetSocketId }` in. Removes the target from `coHostIds` (no-op, not an error, if they weren't a co-host).
- `room:transferHost` (client→server, ack) - `{ targetSocketId }` in. Sets `hostId` to the target and adds the OLD `hostId` to `coHostIds` (voluntary transfer makes the outgoing primary a co-host, not a plain participant, for room continuity); ack error `'ALREADY_PRIMARY_HOST'` if transferring to yourself.
- All three broadcast `room:update`. Upload-token consumption (`uploadRoute.js`) and `track:requestUploadToken` (`trackHandlers.js`) both re-check `hostId === socketId || coHostIds.has(socketId)` at the moment of use, not just at issue time - a co-host demoted (or a host who transferred away) between requesting a token and consuming it loses upload rights immediately, reusing the exact lazy-recheck pattern Phase 6 established for former hosts.

## Synchronization algorithm (current state)
- Clock offset (Phase 3, `client/src/clockSync.js`): 9 sequential Cristian's-
  algorithm samples per sync round, each using `clock:ping`
  (`offset_i = serverTime_i + rtt_i/2 - clientReceiveTime_i`). Robust
  aggregation: sort samples by RTT ascending, keep the lowest half (minimum
  3), then take the **median** offset and RTT of that kept subset — no
  single sample is ever trusted directly. A sample that times out (2s) is
  skipped, not fatal; if every sample fails, status is `'failed'` with a
  `null` offset rather than throwing. Convention: `serverTime = clientTime +
  offsetMs`, so `clientTime = serverTime - offsetMs`.
- Sync triggers: on room join/mount (`Diagnostics.jsx` effect) and on the
  Socket.IO manager's `reconnect` event. A manual "Re-sync" button is also
  available for diagnostics/demo purposes.
- The Phase 0 PoC's original single-sample estimate (`server/public/client.js`)
  is untouched and still works standalone at `http://localhost:3001/` — the
  real app's Phase 3 protocol lives entirely in `client/src/clockSync.js` and
  reuses the same `clock:ping` server primitive, not a copy of it.
- Scheduling (Phase 4, real app, `client/src/playbackEngine.js`): server
  never says "play immediately" - `playback:play`/`pause`/`seek` all compute
  a future `anchorServerTime` (now + 1000ms lead, `PLAYBACK_SCHEDULE_LEAD_MS`
  in `roomManager.js`). Each client converts it to a local delay using its
  own Phase 3 offset (`computeAudioContextStartTime`, pure/testable) and
  schedules against `AudioContext.currentTime` - never an immediate
  `source.start()`/`.stop()` call. `AudioBufferSourceNode` is one-shot, so
  every play/seek creates a fresh node; the outgoing node (if any) and the
  incoming one are both scheduled at the *same* future instant so a seek is
  a synchronized cut, not a race.
  (The Phase 0 PoC has its own, separate, always-immediate-lead scheduling
  path in `server/public/client.js` - untouched, not reused by Phase 4.)
- Playback versioning (Phase 4): a single monotonic `playback.version` per
  room, bumped by every play/pause/seek and by track replacement. Clients
  only apply a `room:update`'s `playback` field if its version is strictly
  newer than the last one they applied (`isNewerPlaybackVersion`, pure/
  testable) - protects against stale/out-of-order/duplicate broadcasts. A
  client additionally refuses to schedule audio for a `playback.trackVersion`
  it hasn't decoded yet (logs a warning, does not crash) - protects against
  acting on superseded audio.
- Drift measurement + correction (Phase 5, `client/src/driftMonitor.js` +
  `Room.jsx`, `client/src/playbackEngine.js`'s `currentAnchor`): while
  `playback.status === 'playing'`, every 2s (`DEFAULT_MEASURE_INTERVAL_MS`):
  - Expected position = `positionSec + max(0, (estimatedServerNow - anchorServerTime)/1000)`
    (`computeExpectedPositionSec`, mirrors the server's `getCanonicalPosition`
    client-side using the Phase 3 offset for `estimatedServerNow`).
  - Actual position = the engine's own scheduling anchor
    (`{audioContextTime, bufferOffsetSec}`, set on every `schedulePlay`)
    extrapolated by elapsed `AudioContext.currentTime` (`computeActualPosition`).
  - `driftMs = (actual - expected) * 1000` (positive = client ahead, negative
    = behind).
  - A sample violates if `|driftMs| >= 80ms` (`DEFAULT_DRIFT_THRESHOLD_MS`,
    configurable). 2 consecutive violations required to correct
    (`DEFAULT_REQUIRED_CONSECUTIVE_VIOLATIONS`) - a single noisy sample never
    triggers one. `evaluateDriftSample` is the pure state-machine step
    (violations/cooldown/correction-count), fully unit-tested without any
    timers/AudioContext/socket.
  - Correcting reuses the exact same `schedulePlay` used for seeks: a fresh
    `AudioBufferSourceNode` at the authoritative position extrapolated to
    `now + offsetMs + 150ms` (`DEFAULT_CORRECTION_LEAD_MS` - a small *local*
    lead since this is a per-device self-correction with no network round
    trip to wait on, unlike the 1000ms room-wide command lead). The old
    source is stopped at that same instant (same synchronized-cut mechanism
    Phase 4 already established for seeks).
  - A 5s cooldown (`DEFAULT_CORRECTION_COOLDOWN_MS`) follows each correction;
    violations still accumulate during it (so persistent drift corrects again
    immediately once cooldown lifts), but no new correction fires mid-cooldown.
  - Every measurement (not just corrections) is reported to the server via
    `playback:driftReport` for diagnostics visibility.
  - Does nothing while paused (the monitoring `setInterval` isn't even
    created), and `canMeasureDrift` refuses to measure/correct if this
    device's decoded track version doesn't match the authoritative
    `playback.trackVersion` - protects against acting on stale/superseded
    audio, same principle as the main playback-apply effect.
  - `canMeasureDrift` (Phase 6) also refuses to run without a genuinely
    completed clock sync (third param `hasClockSync`, default `true` so all
    Phase 5 call sites/tests are unaffected) - closes the same 0ms-fallback
    gap for drift correction that recovery closes for the main playback path.
- Recovery (Phase 6, `client/src/recoveryState.js` + `Room.jsx`): synchronized
  playback is never scheduled until FOUR prerequisites all hold -
  `roomJoined` (this exact connection has a confirmed room membership),
  `hasLatestState` (an authoritative `playback`/`track` snapshot has been
  received since the last (re)join), `trackDecoded` (the decoded buffer
  version matches `track.version`, or vacuously true if there's no track),
  and `clockSynced` (`getClockOffsetMs() !== null` - a real completed sync,
  never a 0ms fallback). `arePrerequisitesMet` is the pure gate.
  - Every `room:update` (including a join/rejoin ack) feeds its `playback`
    into `recoveryState.js`'s `receivePlaybackState`, which always overwrites
    whatever was pending - never a queue, so only the newest authoritative
    state is ever the candidate to apply.
  - Whenever any prerequisite or the pending state changes, `Room.jsx`'s
    apply effect calls `tryConsumePending`: if all prerequisites hold and the
    pending state's version is newer than what was last applied
    (`isNewerPlaybackVersion`, reused from `playbackEngine.js` - not
    reimplemented), it's applied via the *same* `schedulePlay`/`schedulePause`
    Phase 4 established, exactly like a normal play/pause/seek broadcast. A
    stale/duplicate pending state (not newer) is discarded without applying.
  - For a `'playing'` pending state, `tryConsumePending` does NOT pass the
    command's original `positionSec`/`anchorServerTime` straight through -
    that snapshot is only valid at the moment the command was issued, and by
    the time recovery finishes (late join or reconnect), real time has moved
    on. It instead calls `computeScheduledPlayingState(playback,
    nowServerTimeMs, {leadMs, durationSec})`: `targetServerTime =
    max(anchorServerTime, nowServerTimeMs + RECOVERY_SCHEDULING_LEAD_MS)`,
    then `positionSec = computeExpectedPositionSec(playback,
    targetServerTime)` - the exact same canonical-position formula the
    server's `getCanonicalPosition` and the drift monitor already use, not a
    duplicate. Clamped to `durationSec` when known. Because `targetServerTime`
    is never earlier than the command's own `anchorServerTime`, a promptly-
    applied command (the normal case) is completely unaffected - the max()
    picks `anchorServerTime` and the position passes through unchanged; this
    recalculation only does anything once `anchorServerTime` is already in
    the past, i.e. exactly the late-join/recovery case it exists for.
  - Late join: prerequisites simply start unmet (except `roomJoined`/
    `hasLatestState`, true immediately from the join ack) and become met one
    by one (clock sync completes, decode finishes) - no special-cased "late
    join" code path exists; it's the same mechanism as any other recovery.
    If the room is playing, the position above is calculated for the actual
    moment scheduling happens, so the device starts silent-until-ready and
    then begins directly at the correct elapsed position - never at 0 and
    never audibly starting-then-jumping. If paused, `schedulePause` on a
    fresh engine (nothing playing) is a safe no-op - the paused position is
    simply adopted for display via `state.playback.positionSec`, with no
    audio ever started.
  - Reconnect: on the Socket.IO manager's `reconnect` event, `roomJoined`,
    `hasLatestState`, and `clockSynced` are all explicitly reset to false
    (guarded against overlapping rejoin attempts via `rejoinInFlightRef`),
    then `room:join` is re-emitted with the room code/name remembered from
    the original join (`roomCodeRef`/`myNameRef`, captured once at mount).
    Diagnostics.jsx already re-syncs the clock on this same event (unchanged
    from Phase 3); `client/src/clockSync.js` gained a small `onClockSyncResult`
    pub/sub so `Room.jsx` can react to that completion without duplicating
    the trigger. If the rejoin ack fails (room genuinely gone), `Room.jsx`
    logs a warning and calls `onLeave()` to return to the landing screen.
  - The already-decoded `AudioBuffer` is NOT re-decoded on reconnect (decode
    doesn't depend on the connection) - only a genuinely new/different track
    (revealed by the fresh post-reconnect state) triggers the existing decode
    effect, unchanged from Phase 4.
  - Disconnect: the moment the socket `disconnect` event fires (or, faster in
    practice, the browser's own `window` `offline` event - both call the
    exact same `resetPlaybackEngine()`), this device's local Web Audio source
    is stopped immediately. This does NOT call `playback:pause` or touch
    authoritative room state in any way - a participant losing connectivity
    is purely a local event; other devices keep playing uninterrupted. The
    decoded `AudioBuffer` (`bufferRef.current`, a `Room.jsx`-level ref, not
    touched by `resetPlaybackEngine()`) is preserved, so a reconnect doesn't
    need to re-download/re-decode. `clockSynced` is also dropped immediately
    on disconnect (not just on the later `reconnect` event), which - via
    `canMeasureDrift`'s `hasClockSync` gate - stops drift correction from
    running during the disconnected/recovering window too. The `offline`
    listener never touches `roomJoined`/room-membership state; only
    Socket.IO's own connect/disconnect/reconnect events do that, per "keep
    server state authoritative for room membership."
- Host reassignment + room cleanup (Phase 6, `server/roomManager.js`): when
  the current host's socket disconnects (or leaves), `promoteNewHost` picks
  the remaining client with the lowest `joinedAt` (deterministic - always the
  same choice given the same membership) and reassigns `room.hostId`; if no
  one remains, `hostId` becomes `null`. A former host who later reconnects
  gets a brand-new `socket.id` via a normal `room:join` and is never
  special-cased back into `hostId` - they return as an ordinary participant.
  When a room becomes empty, it is NOT deleted immediately: `scheduleRoomCleanup`
  starts a `.unref()`'d, test-overridable (`setRoomCleanupGraceMsForTesting`)
  ~30s timer (`ROOM_CLEANUP_GRACE_MS`). A `room:join` for that code during the
  grace period cancels the timer and restores the room (track/playback state
  preserved, not reset); if the room was empty, the joiner becomes host. If
  the timer fires while still empty, the room is deleted, its outstanding
  upload tokens are purged (`uploadTokens.purgeRoom`), and a registered
  `onRoomDeleted` listener fires so `server/index.js` can delete the track
  file - `roomManager.js` itself has no filesystem knowledge.
- Canonical-position clamping + natural completion (bugfix round after
  Phase 6, `server/roomManager.js` + `client/src/driftMonitor.js`): every
  canonical/expected-position calculation is clamped to `[0, durationSec]`
  once duration is known - `getCanonicalPosition` (server) reads
  `room.track?.durationSec` directly; `computeExpectedPositionSec` (client)
  takes an optional 3rd `durationSec` param and is THE single helper reused
  by recovery (`computeScheduledPlayingState`), drift measurement/correction,
  and the `PlaybackControls` display (which used to duplicate the formula -
  now calls the shared helper instead, closing that duplication too).
  - Server-side end timer: `scheduleEndTimer(room)` computes
    `remainingSec = durationSec - positionSec`,
    `endServerTime = anchorServerTime + remainingSec * 1000`, and sets a
    `.unref()`'d timeout capturing the playback version and track version it
    was scheduled for. On fire, it re-checks room identity + both versions +
    status before calling `completeNaturalPlayback` (→ `status: 'paused'`,
    `positionSec: durationSec`, version bump, broadcast via a new
    `onPlaybackCompleted` listener - mirrors `onRoomDeleted`'s pattern so
    `roomManager.js` still never touches `io`). Any intervening command
    (all of which bump `playback.version`) makes a stale timer a safe no-op.
  - Scheduled/cancelled on: `issuePlayCommand` (schedules),
    `issuePauseCommand` (cancels), `issueSeekCommand` (reschedules if still
    playing, else cancels), `setTrack` (cancels - old track's timer must
    never fire for the new one), `setReady` (schedules retroactively if
    duration just became known *while already playing* - covers a host
    pressing Play before their own device finishes decoding), and final
    room deletion (cancels, preventing a leak - NOT at the start of the
    empty-room grace period, since playback state is otherwise preserved
    during that window and the stale-version check makes an active timer
    harmless if someone rejoins).
  - No new `'ended'` status was introduced - natural completion is just a
    normal `paused` state at `positionSec === durationSec`. This means late
    join/reconnect-after-completion needed ZERO new client code: the
    existing paused-state path (no `schedulePlay` call) and the existing
    `canMeasureDrift` paused-gate (drift measurement/correction already
    stops) both already do the right thing once completion is "just a
    pause" - the entire fix is about correctly *reaching* that state and
    clamping the numbers along the way, not new state-machine branches.
  - Play restart-from-0 (Requirement 10): `issuePlayCommand` checks
    `positionSec >= durationSec - COMPLETION_EPSILON_SEC` (epsilon 50ms, for
    floating-point safety) using the canonical position it already computes,
    and resets to 0 before constructing the normal future-scheduled command -
    no special scheduling path, so all devices still restart together via
    the existing mechanism.
  - Client `onended` (`playbackEngine.js`): `schedulePlay`'s source now sets
    `onended` to clear `currentSource`/`currentAnchor`, but ONLY if that
    exact source is still the current one - `.stop()` is also called
    intentionally for pause/seek/drift-correction/recovery, which fires
    `onended` too, so an unguarded handler would risk clobbering a newer
    source's state if the old node's `onended` fires after a replacement was
    already scheduled. Purely local cleanup - never emits a socket event
    (the server's own end timer, not this event, decides natural completion
    for the room) - closes the brief gap between the local node naturally
    stopping and the server's completion broadcast arriving, during which
    `getActualPositionSec()` would otherwise keep extrapolating past the
    real (stopped) position.
- Queue + preload + synchronized transitions (Phase 6.2A, `server/roomManager.js`'s
  `addToQueue`/`removeFromQueue`/`reorderQueue`/`setNextReady`/`advanceToNextTrack`/
  `issueNextCommand`, `client/src/components/Room.jsx`'s next-track preload effect):
  - A manual Next and an automatic advance (queue non-empty at natural completion)
    are the SAME operation, `advanceToNextTrack`: cancel the old track's end timer,
    shift `queue[0]` into `room.track` (a track replacement exactly like `setTrack` -
    bumps `track.version`, clears `readyDevices`), start it playing from `positionSec: 0`
    at `Date.now() + PLAYBACK_SCHEDULE_LEAD_MS`, then call `scheduleEndTimer` again for
    the new track. Reusing the *same* 1000ms lead every other playback command uses
    (rather than a separate "transition" lead) means a track-to-track transition
    involves a short broadcast-scheduling gap rather than sample-perfect gapless
    playback - deliberately out of scope per the brief ("a short controlled transition
    is acceptable; correct synchronization is more important than zero-gap playback").
  - `completeNaturalPlayback` (the Phase 6.1 end-timer callback) now branches on
    `room.queue.length`: empty -> the unchanged Phase 6.1 behavior (pause at
    `positionSec === durationSec`); non-empty -> one `advanceToNextTrack` call, so a
    queued room never broadcasts a permanent paused-at-end state before flowing into
    the next track. Because `advanceToNextTrack` itself calls `scheduleEndTimer` again,
    the completion chain advances through an arbitrarily long queue with zero extra
    bookkeeping - each track's end timer simply schedules the next one.
  - Stale-timer/stale-track protection is entirely the *existing* Phase 6.1 mechanism,
    unmodified: `scheduleEndTimer` still captures `playback.version`/`track.version` in
    its closure and re-validates both (plus room identity and `status === 'playing'`)
    when it fires. A track that already advanced via manual Next bumped both versions,
    so the OLD track's stale timer (if it was still pending) is automatically a no-op -
    no queue-specific version check was needed.
  - Client-side, a track advance requires ZERO new scheduling code: `advanceToNextTrack`
    produces an ordinary `{track, playback}` update shape (same as any track replacement
    + immediate play), so the *existing* Phase 6 recovery/apply effect in `Room.jsx`
    (`tryConsumePending` + `schedulePlay`) handles it automatically once `decodedVersion`
    matches the new `track.version`. This is also why "an unready device stays silent and
    recovers once decoded" (the spec's required MVP policy for a slow next-track
    preload) needed no new code either - it's exactly the existing `trackDecoded`
    prerequisite gate, which already keeps `toApply` `null` until decode catches up, at
    which point `computeExpectedPositionSec` naturally computes the real elapsed
    position into the new track rather than 0.
  - Client-side preload (`Room.jsx`): a SEPARATE `useEffect`, declared after the
    current-track decode effect (current-track recovery takes priority per the spec),
    decodes ONLY `state.queue?.[0]` into a second ref (`nextBufferRef`, distinct from
    `bufferRef`) and reports `queue:trackReady`. When that same track later becomes
    current, the current-track decode effect checks `nextBufferRef.current.trackId`
    first and PROMOTES the already-decoded buffer (no re-download/re-decode) if it
    matches exactly - the same identity-match discipline the server applies to
    `setNextReady`. A preload failure is non-fatal (logged, not surfaced as a blocking
    UI error) - the device just falls back to a normal decode once the track actually
    becomes current, same recovery path as any late-decoding device.
  - Next-track readiness (`nextReadyDevices`) is informational only - `issueNextCommand`
    never checks it before transitioning (the spec's deterministic MVP policy: the
    server always transitions authoritatively regardless of per-device readiness). It's
    cleared whenever `queue[0]`'s `trackId` identity changes (add-to-empty-queue,
    remove-of-queue[0], a reorder that changes the front, or an advance) and left alone
    otherwise (e.g. appending to the back of a non-empty queue), reusing the exact
    Set-based staleness pattern `readyDevices`/`track:ready` already established.
- Multi-device join reliability + stale-source retirement (Phase 6.2A.1,
  `client/src/clockSync.js`, `client/src/audioEngine.js`,
  `client/src/playbackEngine.js`, `client/src/components/Room.jsx`,
  `client/src/components/Diagnostics.jsx`): real multi-device testing found
  two problems, investigated per the brief before any code changed.
  - Investigation finding: every scheduling-relevant `useEffect` in
    `Room.jsx` was ALREADY keyed on primitive fields (`state.track?.version`,
    `state.playback?.version`, `state.queue?.[0]?.trackId`), not the whole
    `state` object - so a membership-only `room:update` (someone else
    joining/leaving) does NOT, by itself, re-trigger decode/recovery/drift
    effects; React's dependency-array shallow-equality already prevents that.
    The actual join-burst slowdown traces to real ASYNC RACES, not
    accidental effect re-runs: (a) `handleUpdate` unconditionally called
    `receivePlaybackState` on every broadcast, marking a value-identical
    "pending" entry even when nothing changed - wasteful, not incorrect
    (`tryConsumePending`'s existing version check discarded it), but now
    guarded by a `lastSeenPlaybackVersionRef` version comparison so it's a
    true no-op; (b) `runClockSync` had no protection against two overlapping
    calls (e.g. mount-triggered sync still running when a reconnect fires
    another) - whichever finished LAST would win regardless of which
    STARTED last, capable of overwriting a newer offset with a stale one.
  - Fix: `clockSync.js` gained a monotonic `syncGeneration` counter - each
    `runClockSync` call captures its own generation at start and only
    applies its result if it's still the latest when it finishes, so an
    older call finishing late can never overwrite a newer one.
    `Diagnostics.jsx` additionally gained a `syncInFlightRef` guard so two
    calls from the SAME component never both run a full 9-sample round
    concurrently in the first place. `audioEngine.js`'s `decodeTrackFromUrl`
    gained an in-flight-promise cache keyed by url, deduping concurrent
    decode requests for the same file (e.g. a StrictMode double-invoke, or
    the current-track and next-track preload effects happening to target the
    same URL). `recoveryState.js`'s local scheduling lead
    (`RECOVERY_SCHEDULING_LEAD_MS`) was raised from 150ms to 300ms - real
    testing found 150ms too tight for a device also under load finishing a
    decode/clock-sync; still far short of the ~1000ms room-wide command lead,
    which is untouched.
  - Issue 2 (stale old-track playback on an unready Next client): root cause
    was that the recovery-apply effect's "not decoded yet" branch just
    logged a warning and returned - it never called `schedulePause`, so an
    unready device's OLD source kept playing indefinitely, since nothing
    ever told it to stop. Fixed by separating "retire the stale source" from
    "start the new one": `playbackEngine.js` now tracks
    `currentTrackVersion` alongside `currentSource`/`currentAnchor`
    (`getCurrentTrackVersion()`, set by every `schedulePlay` call, cleared by
    `schedulePause`/`onended`/`resetPlaybackEngine`), and `Room.jsx` gained a
    SEPARATE effect (declared after the recovery-apply effect, so a ready
    device's own `schedulePlay` call already updated
    `getCurrentTrackVersion()` before this one evaluates) that compares it
    against `playback.trackVersion` and calls `schedulePause` whenever they
    differ - REGARDLESS of whether this device has decoded the new track.
    Starting the new track remains fully gated on `trackDecoded` via the
    unchanged recovery-prerequisite mechanism; only STOPPING the old one was
    ever incorrectly coupled to buffer readiness. Applies identically to
    manual Next and automatic advance (both produce the same
    `{track, playback}` shape via `advanceToNextTrack`), and drift correction
    was already safe without any change (`canMeasureDrift`'s existing
    decoded-track-version check already refuses to act on a track this
    device hasn't decoded).

## Important decisions
- Phase 0 PoC lives under `server/public` as plain HTML/JS (no React yet) so
  the mechanism can be proven before Phase 1 introduces the React app and
  real room structure. `server/index.js` and the Socket.IO wiring will be
  extended in place, not thrown away. It is still fully functional at
  `http://localhost:3001/`.
- Test audio is a generated WAV tone (`server/scripts/generate-tone.js` →
  `server/public/audio/test-tone.wav`) with a 1-tick/second envelope so
  sync/drift is audible by ear, avoiding dependency on a sourced audio file.
- React client scaffolded with Vite. The scaffolder's default (`vite@8`
  with the experimental `rolldown-vite` bundler) has a broken native binding
  on this Windows/Node 20.12.2 combo (`Cannot find native binding` /
  `@rolldown/binding-win32-x64-msvc` missing) — pinned to stable
  `vite@^5.4.11` + `@vitejs/plugin-react@^4.3.1` instead, which installs and
  runs cleanly. Revisit only if the team upgrades Node past 20.19/22.12.
- Room manager is in-memory only (`Map`), matching the "no database" MVP
  constraint. Room codes are 5-char, unambiguous-alphabet, collision-checked.
- Host disconnect (Phase 1-5): `hostId` was set to `null` (no auto-promotion) -
  deliberately minimal pending Phase 6's real policy. Superseded by Phase 6's
  deterministic longest-connected-member promotion (`promoteNewHost`); see
  the "Synchronization algorithm" section's "Host reassignment + room
  cleanup" entry for the current behavior. Left here as a record of the
  earlier decision, not the current one.
- Vite dev server proxies `/socket.io` (with `ws: true`), `/api`, and
  `/uploads` to `localhost:3001` so the browser only ever talks to one
  origin; no CORS config needed on the Express server.
- Upload authorization uses a server-issued token, not a client-claimed
  identity: `room:update` already broadcasts `hostId` to every client, so
  trusting a client-supplied socket id in the HTTP upload request would let
  any participant forge host access. `track:requestUploadToken` checks the
  real (unspoofable) `socket.id` against `room.hostId` and issues a
  single-use, 30s-TTL token; `POST /api/upload` only proceeds with a valid
  token. This is the one place in Phase 1/2 where "keep it simple" was
  overridden for a genuine access-control gap, not scope creep.
- File-type validation is by extension only (`.mp3`/`.wav`), not MIME
  sniffing — browser-reported MIME types for these formats are inconsistent
  across OS/browser combinations. This is a UX filter, not a security
  boundary: a mislabeled file that slips through still fails gracefully at
  `decodeAudioData()` on the client (handled - see READY state below).
- Track versioning (`room.track.version`, separate counter from the future
  Phase 4 playback-state version) exists specifically so a slow client's
  decode of a superseded track can't incorrectly mark it READY - `track:ready`
  is rejected if its version doesn't match the room's current track.
- Replacing a track deletes the previous file from `server/uploads/`
  (one-current-track-at-a-time semantics; prevents unbounded local disk
  growth without needing a cleanup job).
- Client `Room.jsx` auto re-decodes whenever `track.version` changes, as
  long as audio was already enabled once — the AudioContext unlock only
  needs a single user gesture per tab session; subsequent track changes
  don't need another click, since `decodeAudioData` itself has no gesture
  requirement (only starting playback does, which isn't implemented yet).
- Clock sync is client-driven and reuses the existing `clock:ping` ack
  rather than inventing a new server-side sampling protocol - the server
  only needed to keep doing exactly what it already did (echo back its
  wall-clock time); all the sampling/filtering/median logic lives in
  `client/src/clockSync.js`, which is plain, dependency-free JS specifically
  so it can be imported and unit-tested directly with Node's built-in
  `node:test` runner (no Jest/Vitest introduced).
- Server-side storage of each client's RTT/offset (`clock:report`) is
  informational only, broadcast for diagnostics/UI visibility (device list
  RTT readout) - it is never read back to make authoritative decisions.
  Each client independently keeps its own offset for its own scheduling use
  once Phase 4 needs it.
- Reconnection triggers a re-sync (`socket.io.on('reconnect', ...)`). A
  reconnect gets a brand-new `socket.id`, and Socket.IO does not auto-rejoin
  rooms - Phase 3-5 left this as a known gap (`clock:report` would no-op
  post-reconnect since the new socket wasn't in any room yet); Phase 6
  closes it by having `Room.jsx` explicitly re-emit `room:join` on the same
  `reconnect` event, so by the time diagnostics/drift reporting run again,
  the new socket is already a confirmed room member.
- Test suite added at `client/test/` using Node's built-in test runner
  (`node --test`, zero new dependencies): `clockSync.unit.test.mjs` (pure
  filtering/median logic, always runnable) and
  `clockSync.integration.test.mjs` (imports the real client module against a
  live server on :3001 - requires `cd server && npm start` first; not
  auto-started because `server/index.js` binds its port as a load-time side
  effect and isn't structured for in-process test harnessing yet - that
  refactor belongs to Phase 7's "automated tests" scope, not Phase 3's).
- Playback control reuses `room:update` rather than introducing a separate
  `playback:update` event. Considered a dedicated channel (playback carries
  a scheduling-relevant timestamp general room refreshes don't), but
  `toPublicState()` already includes `playback` in every broadcast, and the
  client's version-guard (`isNewerPlaybackVersion`) means unrelated
  `room:update`s (e.g. someone else's `clock:report`) are naturally inert -
  their `playback.version` hasn't changed, so the effect just doesn't
  re-fire. One event, one source of truth, less to keep in sync.
  `anchorServerTime` inside `playback` serves as the scheduling target, so
  no separate `targetServerTime` field is needed either.
- Server-side seek validation only checks `position >= 0` and finiteness
  unconditionally; the upper bound (`SEEK_OUT_OF_RANGE`) only applies once
  `track.durationSec` is known (first client to decode reports it via
  `track:ready`). Before that, an out-of-range seek isn't rejected server-side
  - but it's still handled gracefully client-side: Web Audio's
  `AudioBufferSourceNode.start(when, offset)` simply produces no sound if
  `offset >= buffer.duration` (`playbackEngine.js`'s `schedulePlay` checks
  this explicitly and skips creating a source rather than letting Web Audio
  do it implicitly, so the "nothing to play" case is deliberate, not
  incidental).
- (Phase 4, SUPERSEDED by Phase 6) A device with no clock-sync estimate yet
  used to fall back to `offsetMs = 0` for scheduling rather than refusing to
  play. Phase 6 removed this: the `clockSynced` recovery prerequisite now
  means nothing is scheduled at all until a real sync has completed - see
  "Recovery" below and the Phase 6 bugfix entry in Known issues. Left here as
  a record of the earlier (now-reverted) tradeoff, not the current behavior.
- `PlaybackControls` shows a live-ish extrapolated position (`~12.3s`,
  updated every 250ms via `setInterval` while playing) using the exact same
  extrapolation formula as the server's `getCanonicalPosition`, but this is
  cosmetic display only - it never feeds back into scheduling and is not
  drift measurement/correction (that's Phase 5's explicit scope; this is
  just "don't show a frozen number while audio is audibly playing").
- Server test suite added at `server/test/` (`node --test`, matching the
  client's Phase 3 approach): `socket.io-client` added as a devDependency
  (server itself doesn't need it) purely for the integration tests.
- `isHost` moved from a stored per-client field to a value computed in
  `toPublicState()`. This is the one place Phase 6 touched genuinely
  Phase 1-era code, and it's a correctness fix required by host
  reassignment: a stored `isHost` flag would go stale on every promotion
  unless painstakingly kept in sync on every client entry; computing it from
  `room.hostId` at read time makes that entire class of bug structurally
  impossible.
- Former-host upload-token rejection is checked lazily, at consumption time
  (`uploadRoute.js`), not proactively invalidated the instant host changes.
  Tokens are already single-use and short-lived (30s TTL), so lazy checking
  fully satisfies "must no longer grant host privileges" without needing to
  track "all outstanding tokens per socket" for proactive cleanup.
- The empty-room grace-period timer is `.unref()`'d specifically so it never
  blocks a live server process from exiting, and its duration is swappable
  via `setRoomCleanupGraceMsForTesting` specifically so tests don't have to
  wait 30 real seconds - both are test/ops conveniences, not behavior changes
  to the ~30s default a real empty room actually gets.
- Recovery prerequisites are deliberately four SEPARATE named booleans
  (`roomJoined`, `hasLatestState`, `trackDecoded`, `clockSynced`) even though
  in this app's actual wiring `roomJoined` and `hasLatestState` currently
  always become true at the same instant (the join/rejoin ack delivers both
  "we're a member" and "here's the state" atomically). Kept separate because
  they're conceptually distinct (spec names them separately), the
  `recoveryState.js` tests exercise them independently for robustness, and
  it costs nothing to keep the distinction explicit if the data flow ever
  changes.
- The Phase 5 drift-correction and Phase 6 recovery-apply effects in
  `Room.jsx` are two separate `useEffect`s (not merged into one), consistent
  with how the codebase has kept "decode," "apply playback," and "measure
  drift" as separate effects since Phase 4/5 - each has a distinct
  dependency array and reason to re-run, and merging them would make the
  dependency array's meaning far less legible.
- Drift correction is a purely local, per-device self-correction - it does
  NOT call `playback:seek`/round-trip through the server. Drift is inherently
  a per-client phenomenon (each device's own clock/audio-clock relationship
  drifts independently), so there's nothing for the room to agree on; only
  the drifted device needs to act, and it already has everything it needs
  (the authoritative `playback` state it already received, plus its own
  offset) to compute the correction itself. This is also why the correction
  lead time (150ms) is much shorter than the 1000ms room-wide command lead -
  no network round trip to wait out, just enough lead for Web Audio to
  schedule reliably.
  The "do nothing while paused" requirement is enforced entirely at the call
  site, not inside the state machine: `Room.jsx` doesn't even start the
  monitoring `setInterval` unless `playback.status === 'playing'`, so
  `evaluateDriftSample` never needs a "paused" branch of its own.
- The violation-streak/cooldown state resets on every `playback.version`
  change (a fresh authoritative command deserves a fresh evaluation), but the
  cumulative `correctionCount` only resets on `track.version` change - it's
  meant to answer "how many times has this device needed correcting for the
  current track", not "since the last play/pause/seek" (which would reset it
  constantly during normal use and make the stat useless).
- `playback:driftReport` broadcasts a full `room:update` on every ~2s
  measurement per playing client, same as `clock:report`'s existing pattern.
  No throttling/deduping added - acceptable chatter for the MVP's small-room
  scale; revisit only if it becomes a real problem (Phase 7 benchmarking
  would surface that).
- Phase 6 bugfix round (found via real laptop/phone testing, fixed before
  Phase 7 started): late join was silently starting audio at track position
  0 for 1-2s before the drift monitor corrected it. Root cause: the recovery
  apply path passed the authoritative command's original
  `positionSec`/`anchorServerTime` straight to `schedulePlay` unchanged. That
  snapshot is only valid at the instant the command was issued; `schedulePlay`
  itself already clamps a past `anchorServerTime` to "start now"
  (`Math.max(ctx.currentTime, ...)`), but was still being told to start at
  the OLD (stale) buffer offset, i.e. correct time, wrong position. Grepped
  every `schedulePlay` call site to confirm there was no second/legacy
  effect bypassing `recoveryState.js` - there wasn't; the bug was entirely in
  `tryConsumePending` not recalculating position at all. Fixed by adding
  `computeScheduledPlayingState` (reuses `computeExpectedPositionSec` from
  `driftMonitor.js`, not a duplicate formula) and threading a `context`
  parameter (`nowServerTimeMs`, `durationSec`) through `tryConsumePending`.
  Chose a 3rd parameter over folding it into `prereqs` because it's data
  (a timestamp/duration), not a boolean gate - keeping the distinction
  legible in the function signature.
- Same round: a participant's socket disconnecting mid-playback used to
  leave its local Web Audio source running indefinitely (Web Audio doesn't
  care about socket state) rather than stopping. Fixed by calling the
  existing `resetPlaybackEngine()` (already used for "leave room" - no new
  function needed) from both the socket `disconnect` handler and a new
  `window` `offline` listener. The `offline` event is purely a faster
  trigger for the identical action; Socket.IO's own `disconnect` already
  fires the correct sequence and remains what actually resets recovery
  prerequisites - the offline handler doesn't duplicate or race that.
- Phase 6.2A: re-uploading while a current track exists now queues instead of
  replacing. This is a deliberate behavior change from Phase 2 (where a
  second upload always replaced the current track) - now that a queue
  exists, "replace what's playing" is superseded by "queue it, then Next"
  (or let it play out and auto-advance), which is a strictly more useful
  default once there's somewhere else for the file to go. No existing test
  depended on the old replace-on-reupload behavior (confirmed by inspection -
  every existing upload test only uploads once per room); `roomManager.setTrack`
  itself is untouched and still directly available/tested for "replace current
  track" as a primitive, it's only `uploadRoute.js`'s routing decision that
  changed.
- `queue:next` always results in `status: 'playing'` on the new track, even if
  the room was paused beforehand - Next is inherently a "skip to and play the
  next track" action (matching the common queue-UX expectation, e.g.
  Spotify's skip), not a "replace current track but preserve paused/playing
  state" operation. Consistent with the automatic-advance case, which must
  always end up playing (a track just finished playing).
- `trackId` (see Room-state model above) was added as a minimal, single-purpose
  per-file identity rather than a second monotonic "version" family - it answers
  "is this a preload report for the CURRENT queue[0]" and nothing else.
  `track.version` and `playback.version` needed no changes at all for queue
  reorder/advance/preload-readiness: a queue advance is just another track
  replacement (reuses `track.version`) plus another authoritative state change
  (reuses `playback.version`), and queue-only mutations (add/remove/reorder
  that don't touch `queue[0]`) don't bump either since they don't touch
  current track/playback state - see "Queue + preload + synchronized
  transitions" above.
- Co-host design (Phase 6.2B): considered a flat `Set<socketId>` of "hosts"
  with no primary/secondary distinction, rejected per the brief's explicit
  "do NOT create several equal room owners" - promote/demote/transfer must
  have exactly one authority, so `hostId` (single) + `coHostIds` (delegated,
  broader) stayed structurally separate, with two authorization checks
  (`requireHost` strict-primary, `requireController` primary-or-co-host)
  rather than one flag with runtime role branching.
- Voluntary transfer makes the OLD primary a CO-HOST, not a plain
  participant - explicit in the brief ("gives intuitive room continuity"),
  and reuses the exact same `coHostIds` mechanism rather than inventing a
  "former host" concept.
- Failover (disconnect, not voluntary transfer) prefers a co-host over an
  earlier-joined plain participant - a co-host already has demonstrated
  delegated trust, so continuity of control matters more than raw
  connection order there. Explicit transfer and failover are still two
  separate code paths (`transferPrimaryHost` vs `promoteNewHost`) since
  their trigger and old-primary's resulting role differ (co-host on
  voluntary transfer; the OLD primary keeps no special role at all after an
  involuntary failover - see Room-state model above).
- Local volume routes every `AudioBufferSourceNode` through one persistent
  `GainNode` (created once, never recreated) rather than setting `.gain` per
  source - sources are recreated on every Play/Seek/drift-correction/Next,
  but the gain node (and therefore the user's chosen volume) must survive
  that churn without being reset each time.
- Calibration is applied ONLY in `playbackEngine.js`'s live `scheduleTimeFor`
  wrapper, added to the network clock offset right before the pure/tested
  `computeAudioContextStartTime` call - never inside that pure function
  itself. Keeps the well-tested clock-conversion formula completely
  unmodified and keeps calibration structurally impossible to confuse with
  the Phase 3 network offset, even though both end up added together at the
  same call site.
- Invite links (`/room/<CODE>`) use a ~15-line regex + `history.pushState`
  in `App.jsx` instead of adding `react-router` - this app has exactly two
  "pages" (Landing/Room), so a full router dependency for one feature would
  be disproportionate. A direct page load on `/room/<CODE>` is served by
  Vite's dev-server SPA fallback in local development; wiring the same
  fallback into a production static-file server is a deployment step, not
  automated by this client-only app (see README's "Running locally").
- The Phase 7 benchmark facility (`client/src/benchmark.js`) stores its
  aggregation state at module scope (like `clockSync.js`'s cached offset),
  not threaded through React state/props - it's fed from several unrelated
  call sites (drift ticks, recovery-apply completions) that shouldn't each
  need to know a `BenchmarkPanel` exists, and the panel itself just polls the
  snapshot on a 1s interval rather than subscribing.
- Duplicated Socket.IO integration-test helpers (`waitConnected`/`emitAck`/
  `waitForRoomUpdate`/`uploadTrack`, near-identically copy-pasted into most
  of `server/test/*.integration-style` files) were extracted into
  `server/testUtils.js` (Phase 7 code-quality pass) - deliberately placed
  OUTSIDE `server/test/`, since Node's default test-file discovery sweeps up
  any `.js` file inside a directory literally named `test`, which would
  otherwise make a pure helper module show up as a phantom zero-assertion
  "test". Adopted in the three newest integration files
  (`queueIntegration.test.js`, `reliability.test.js`,
  `roleIntegration.test.js`); the older pre-existing integration files keep
  their own local copies rather than being touched for this - a deliberate,
  narrower scope than a full repo-wide sweep, per "do not perform a broad
  rewrite" on already-verified suites.

## Completed features
- Phase 0: Socket.IO connection between server and multiple clients; shared
  static test audio; single-sample clock-offset estimate; server-issued
  future `targetServerTime` broadcast; client-side Web Audio scheduled
  playback via `AudioBufferSourceNode`.
- Phase 1: React app (Landing + Room views); room create/join/leave over
  Socket.IO with ack-based responses and error handling for unknown room
  codes; connected-device list with host/you badges; host ownership tracked
  server-side; room state re-broadcast to all members on join/leave/host
  disconnect; basic connection-state indicator in the Room view.
- Phase 2: Host-only audio upload via Multer (MP3/WAV, 25MB limit,
  token-gated host authorization), served locally from `server/uploads/`;
  track metadata in authoritative room state with a version counter;
  `TrackPanel` UI for upload/replace; `audioEngine.js` singleton
  AudioContext with explicit-gesture unlock; automatic per-client
  download+decode whenever the track changes, with a version-checked
  `track:ready` report; READY badges in the device list; decode/upload
  failures surfaced in the UI with a manual retry, no crashes.
- Phase 3: Robust 9-sample clock-offset estimation (`client/src/clockSync.js`)
  reusing the existing `clock:ping` primitive; lowest-RTT-half + median
  filtering so no single sample is trusted; graceful handling of timed-out/
  missing samples (per-sample and total-failure cases); `Diagnostics` panel
  showing sync status/RTT/offset/sample count with a manual re-sync button;
  sync runs on room join and on Socket.IO reconnection; server stores and
  broadcasts each client's latest RTT/offset/status
  (`server/clockHandlers.js`, extended room-client shape) with a compact RTT
  readout added to the device list; 8 scripted tests (4 pure unit tests on
  the filtering/median math, 4 integration tests against the live server
  covering the happy path, unreachable-server handling, cross-client
  broadcast visibility, and the no-room no-op case).
- Phase 4: Authoritative per-room playback state (`status`, `positionSec`,
  `anchorServerTime`, `version`, `trackVersion`) in `server/roomManager.js`;
  host-only `playback:play`/`pause`/`seek` (`server/playbackHandlers.js`)
  computing a future `anchorServerTime` and validating host identity, track
  presence, and seek bounds server-side; canonical position correctly
  maintained for both playing (extrapolated) and paused (frozen) states;
  monotonic playback version bumped by every command and by track
  replacement; client-side `playbackEngine.js` converts the server's target
  time into local `AudioContext` scheduling via the Phase 3 offset, creates
  a fresh `AudioBufferSourceNode` per play/seek (one-shot), and schedules
  the outgoing/incoming nodes at the same instant for a clean synchronized
  cut; `PlaybackControls` UI (host controls + read-only status + live-ish
  position display for everyone); graceful handling of non-host commands,
  no-track commands, invalid/out-of-range seeks, and not-yet-decoded
  devices (warns, doesn't crash). 24 new scripted tests (14 server unit +
  5 server integration + 4 client unit covering host authorization, NO_TRACK/
  NO_ROOM rejection, canonical-position math for both states, version
  increments across play→pause→seek, seek validation, and the
  stale-version-rejection guard), plus a new `server/test/` suite
  (`node --test`, mirroring the client's Phase 3 approach).
- Phase 5: Periodic (2s) playback-drift measurement while playing
  (`client/src/driftMonitor.js` pure functions + `Room.jsx` orchestration);
  expected position from the authoritative `playback` state + Phase 3 offset,
  actual position from a new Web Audio scheduling anchor maintained by
  `playbackEngine.js`; signed drift in ms; 80ms threshold requiring 2
  consecutive violations before correcting, avoiding reaction to single noisy
  samples; corrections are a local, future-scheduled (150ms lead) resync
  reusing the existing seek-scheduling mechanism (fresh `AudioBufferSourceNode`,
  synchronized stop-old/start-new); 5s cooldown after each correction;
  correction count tracked per-track; does nothing while paused; refuses to
  measure/correct against a track version this device hasn't decoded; drift +
  correction count surfaced in the `Diagnostics` panel and an optional
  per-device readout in the device list; reported to the server via
  `playback:driftReport` (`server/driftHandlers.js`) for room-wide
  visibility. 27 new scripted tests (20 client unit tests covering zero/
  ahead/behind drift, threshold boundary, consecutive-violation logic,
  cooldown behavior, paused state, and stale-track-version rejection, plus 3
  more `playbackEngine.js` anchor-math unit tests, plus 4 server integration
  tests for the report/broadcast/no-room/malformed-payload paths) - 58
  scripted tests total across the whole project, all passing.
- Phase 6: Prerequisite-driven recovery (`client/src/recoveryState.js`) -
  late join and Socket.IO reconnect now both go through one mechanism: no
  synchronized playback is scheduled until room-joined, latest-state,
  track-decoded, and clock-synced ALL hold, and only the newest pending
  authoritative state is ever applied (never queued). The 0ms clock-offset
  fallback for scheduling is removed from the production path - both the
  main playback-apply effect and drift correction now wait for a genuinely
  completed sync (`canMeasureDrift` gained a `hasClockSync` gate,
  default-true so existing Phase 5 call sites/tests are unaffected).
  `Room.jsx` now rejoins its room automatically on reconnect using the room
  code/name remembered from the original join, then re-earns each
  prerequisite before resuming synchronized scheduling. Server-side:
  deterministic host promotion (longest-connected remaining member,
  `joinedAt`-based) on host disconnect, with `isHost` now computed from
  `room.hostId` rather than stored per-client so reassignment can't leave a
  stale flag; a former host reconnecting returns as an ordinary participant;
  former-host upload tokens are rejected at consumption time, not just issue
  time; empty rooms get a `.unref()`'d, test-overridable ~30s grace period
  before deletion, during which a rejoin cancels cleanup, restores the room
  (state preserved), and makes the rejoiner host; final deletion purges
  outstanding upload tokens and deletes the track file via a registered
  `onRoomDeleted` listener (`roomManager.js` itself has no filesystem
  knowledge). 36 new scripted tests (13 client unit tests for the recovery
  state machine, 3 new driftMonitor gate tests, 1 new clockSync pub/sub
  integration test, 19 server tests across host reassignment/former-host
  token rejection/room cleanup grace period/duplicate-member prevention/
  late-join+reconnect data flow) - 94 scripted tests total across the whole
  project, all passing.
  **Bugfix round** (real-device testing found two recovery bugs before
  Phase 7 started - see "Important decisions"): (1) late join was starting
  audio at position 0 for 1-2s before drift-correcting, fixed by
  `computeScheduledPlayingState` recalculating the actual position at the
  real scheduling moment instead of reusing a stale snapshot; (2) a
  disconnected participant's local audio kept playing instead of stopping,
  fixed by calling the existing `resetPlaybackEngine()` from both the socket
  `disconnect` handler and a new `window` `offline` listener, without
  touching authoritative state or broadcasting a pause. 9 more scripted
  tests (7 client: exact late-join position formula, significant-elapsed-
  period late join, no-schedule-before-all-prerequisites, no-position-0
  late join, prompt-client-unaffected, duration clamping, reconnect
  resuming from the recalculated position; 2 server: no room-wide pause from
  a participant disconnect, reconnect resumes from the authoritative CURRENT
  position after the host changed it mid-disconnect) - 103 scripted tests
  total across the whole project, all passing.
- Phase 6.1 bugfix round (playback-lifecycle correctness): real-device
  testing found the timeline kept advancing past a track's natural end
  (audio stopped locally, but authoritative state/UI kept extrapolating
  forever). Fixed: canonical/expected-position calculations are now clamped
  to `[0, durationSec]` everywhere they're computed (server
  `getCanonicalPosition`, client `computeExpectedPositionSec` - now the
  single shared helper, deduping what used to be a separate formula in
  `PlaybackControls`); a new server-side `.unref()`'d end timer
  (`server/roomManager.js`) transitions authoritative playback to `paused`
  at `positionSec === durationSec` when a track naturally finishes, protected
  against stale firing by re-checking room/playback-version/track-version
  identity, and (re)scheduled/cancelled on every play/pause/seek/track-
  replacement/room-deletion; completion broadcasts via a new
  `onPlaybackCompleted` listener (mirrors `onRoomDeleted`); Play after
  natural completion restarts from 0 (epsilon-based "already at the end"
  check) using the same future-scheduled mechanism; `playbackEngine.js`
  gained a guarded `onended` handler for local-only anchor cleanup (never
  emits, never touches authoritative state). No new `'ended'` status -
  late-join/reconnect-after-completion and drift-stopping needed zero new
  client code since completion is just a normal paused state. 18 new
  scripted tests (12 server: clamp boundary/never-exceeds, natural
  completion → paused/duration/version-bump, stale-timer protection after
  Pause/Seek/track-replacement, Seek-while-playing reschedules correctly,
  room-deletion clears the timer, completion broadcast, Play restarts from
  0, prompt Play unaffected; 6 client: clamp boundary/never-exceeds/
  uncapped-without-duration, drift monitor inert after completion, late
  join and reconnect after completion both remain paused with no schedule
  instruction) - 121 scripted tests total across the whole project, all
  passing.
- Phase 6.2A: server-authoritative song queue, next-track preloading,
  host-controlled Next, and synchronized automatic transition between
  tracks. `room.queue[]` (each item with a stable `trackId`, separate from
  `track.version`); a second upload now appends to the queue instead of
  replacing the current track (`server/uploadRoute.js` routes on whether a
  current track already exists); host-only `queue:remove`/`queue:reorder`/
  `queue:next` (`server/queueHandlers.js`, reusing a `requireHost` extracted
  to `server/socketUtils.js` from `playbackHandlers.js`); manual Next and
  automatic advance (queue non-empty at natural completion) share one
  `advanceToNextTrack` function, reusing the exact Phase 6.1 end-timer
  architecture (stale-timer protection via the existing version-capture-and-
  recheck, no new counters) so the completion chain can flow through an
  arbitrarily long queue; client preloads ONLY the immediate-next track into
  a second buffer ref and promotes it (no re-download) when it becomes
  current, via the exact same identity-match discipline the server's
  `setNextReady` uses; a track advance needed zero new client scheduling
  code since it reuses the Phase 6 recovery/apply effect verbatim; a slow/
  unready device stays silent and recovers automatically once decoded (same
  `trackDecoded` prerequisite gate, no special-cased policy); file cleanup
  extended to the queue (`server/index.js`'s `onRoomDeleted`/
  `onPlaybackCompleted` listeners, plus direct cleanup in `queueHandlers.js`/
  `uploadRoute.js` for handler-triggered mutations). New `QueuePanel.jsx` UI
  (NOW PLAYING via `TrackPanel`, UP NEXT list, host-only Add/Remove/Move/
  Next, compact "next track ready: X/Y devices" readout). 32 new scripted
  server tests (22 direct roomManager unit tests covering add/remove/
  reorder, preload-readiness identity/staleness, manual Next including
  QUEUE_EMPTY and version-consistency, queue-only mutations leaving current
  playback untouched, natural-completion-with-a-queue advance, stale-timer
  protection across an advance, and late-join/reconnect-mid-transition state
  shape; 10 live-server integration tests covering upload routing, queue
  mutation/readiness/transition broadcasts, host-only rejection, and on-disk
  file cleanup) - 153 scripted tests total across the whole project, all
  passing.
- Phase 6.2A.1 reliability fixes: real multi-device testing found (1) join
  bursts of several devices making synchronization noticeably slower/some
  devices settling late, and (2) a device that hadn't preloaded the next
  track kept playing the OLD track after Next instead of going silent.
  Investigated first per the brief: `Room.jsx`'s scheduling-relevant effects
  were already keyed on primitive version fields (not the whole `state`
  object), so membership-only updates were never accidentally re-triggering
  decode/recovery/drift - the real issues were async races. Fixed: a
  monotonic generation guard in `clockSync.js`'s `runClockSync` so an older,
  slower-finishing sync call can never overwrite a newer one's result; an
  in-flight guard in `Diagnostics.jsx` preventing two overlapping sync
  rounds from the same component; an in-flight decode-promise cache keyed by
  url in `audioEngine.js`; `recoveryState.js`'s local scheduling lead raised
  150ms -> 300ms for more headroom on loaded mobile devices; a
  `lastSeenPlaybackVersionRef` guard so a membership-only broadcast doesn't
  even mark a redundant pending recovery entry. For the stale-track bug:
  `playbackEngine.js` now tracks `currentTrackVersion` alongside the active
  source (`getCurrentTrackVersion()`), and `Room.jsx` gained a dedicated
  effect that retires (stops) a locally-playing source the moment
  `playback.trackVersion` moves on, REGARDLESS of whether this device has
  decoded the new track yet - decoupling "stop the old" from "start the
  new" (which remains gated on `trackDecoded`, unchanged). 6 new scripted
  tests (5 direct roomManager tests in `server/test/reliability.test.js` -
  membership never touches playback/track state (join and leave), a
  multi-joiner live-server test, and a chained A->B->C stale-state test -
  plus 1 client-side clock-sync generation-guard integration test) - 159
  scripted tests total across the whole project, all passing.
- Phase 6.2B final product features: **Primary Host + Co-hosts** -
  `room.coHostIds`, promote/demote/transfer (`server/roleHandlers.js`,
  primary-host-only), playback/queue authorization broadened to
  primary-OR-co-host (`requireController`), failover preferring a connected
  co-host, upload-token re-validation extended to co-hosts, `DeviceList.jsx`
  role badges + primary-only promote/demote/transfer buttons. **Local
  volume** - a persistent `GainNode` in `playbackEngine.js` surviving source
  recreation, `LocalSettings.jsx` slider + mute. **Device calibration** -
  `calibrationOffsetMs` applied only in the live scheduling wrapper (never
  the pure clock-conversion function), persisted via `calibration.js`
  (localStorage, fails gracefully without it). **Screen Wake Lock** -
  `wakeLock.js`, feature-detected, reacquires on visibility change, releases
  on leave/unmount. **Invite link** - `/room/<CODE>` parsed by `App.jsx`,
  `InvitePanel.jsx` copy-code/copy-link. **Queue UI polish** - "Now Playing"/
  "Up Next" headings, compact next-ready readout (pre-existing from Phase
  6.2A, confirmed still correct). 22 new scripted tests (13 direct
  role-management unit tests + 4 live-server role integration tests
  exercising promote/demote/transfer/failover/upload-token-revocation over
  real sockets, plus 3 client unit tests for the new
  `getCurrentTrackVersion`/calibration getters and 2 for calibration's
  localStorage-unavailable fallback) - 181 scripted tests total across the
  whole project, all passing. Client-side volume/calibration/wake-lock code
  itself (the actual GainNode/AudioContext/navigator.wakeLock calls) is
  real-browser-only
  (same AudioContext/`navigator.wakeLock` limitation as all Web-Audio code
  since Phase 0) - verified by code inspection + manual testing, not
  scripted tests, beyond the calibration getter/setter and localStorage
  fallback pure-logic tests that ARE scripted.
- Phase 7 final engineering pass: responsive layout reorder (Room
  name/code/share -> connection/role -> Now Playing -> Playback controls ->
  Queue -> Devices -> Sync Diagnostics -> Local Device Settings) with a
  480px-breakpoint mobile stylesheet pass; a top-level `ErrorBoundary`
  catching unexpected render errors with a generic reload prompt (never a
  raw stack trace to the user); one real listener-cleanup fix
  (`InvitePanel.jsx`'s "copied!" timeout wasn't cleared on unmount); env-var
  overrides for server port/upload-size-limit and the Vite dev-proxy target
  (`VITE_SERVER_URL`), all with working defaults so local dev stays
  zero-config; a small development/benchmark facility
  (`client/src/benchmark.js` + `BenchmarkPanel.jsx`) collecting real
  join-recovery-time, reconnect-recovery-time, and drift-sample aggregates
  (mean/median/P95/max absolute drift, correction count) with a "copy report
  as JSON" action, explicitly never fabricating numbers; duplicated
  Socket.IO integration-test helpers extracted to `server/testUtils.js`
  (adopted in the three newest integration files); the Phase 0 PoC page
  gained an explicit "this is not the app" banner; `docs/benchmarks.md` and
  `docs/cv-metrics.md` created with `TO_BE_MEASURED` placeholders (no
  invented numbers); a full README (overview, features, architecture +
  Mermaid diagrams, sync algorithm, hard problems, queue design, testing,
  benchmark reference, limitations, running-locally, demo script). 8 new
  scripted client tests (`client/test/benchmark.unit.test.mjs` - pure
  aggregation-function coverage for the summarize/record helpers) -
  **189 scripted tests total across the whole project (110 server + 79
  client), all passing.**

## Known issues
- The real app's clock-offset estimate (Phase 3) is robust (9-sample,
  low-RTT/median filtered). The Phase 0 PoC's original single-sample
  estimate still exists untouched in `server/public/client.js`, but that's a
  standalone demo page, not the real app path.
- Drift measurement/correction (Phase 5) is per-device and local only - it
  does not adjust playback rate (no time-stretching/resampling), does not
  calibrate for hardware/output-device latency, and does not coordinate
  across devices beyond each one independently tracking the same
  authoritative timeline. Explicitly deferred per the Phase 5 brief.
  `PlaybackControls`'s position display remains cosmetic/independent of the
  actual drift-correction machinery (separate, simpler extrapolation, no
  measurement or correction tied to it).
- Late join still has an inherent decode-time gap: a joining device is
  silent until it (a) gets the required "Enable Audio" user gesture and (b)
  finishes downloading/decoding the track - this is unavoidable given the
  spec's own requirement that a gesture is mandatory and audio can't be
  scheduled before the buffer exists. Once both are done, Phase 6's
  prerequisite mechanism schedules it correctly into the current timeline
  (extrapolated to the right position if playing, adopted silently if
  paused) - there is no further "fast path" beyond that.
- The empty-room grace period (`ROOM_CLEANUP_GRACE_MS`, ~30s) and drift/sync
  timing constants are code-level constants ("configurable" by editing a
  named value), not live admin/UI knobs - matches how every other tunable in
  this project (drift threshold, correction cooldown, playback schedule
  lead) has been handled since Phase 4/5.
- Duplicate-member prevention after a reconnect is verified for the CLEAN
  disconnect case (a socket that closes normally, or Socket.IO's own
  reconnect logic) - the old entry is removed via the server's `disconnect`
  handler before or as the new one joins, confirmed by
  `server/test/roomCleanup.test.js`'s repeated-cycle test. A genuinely
  SILENT network drop (cable pulled, no clean close) can take up to
  Socket.IO's default ping/pong timeout (tens of seconds) to be detected
  server-side, during which a fast client-side reconnect could briefly show
  two entries for the same physical device in the device list. Eliminating
  that window fully would need persistent per-device session identity
  (deliberately out of scope - the brief excludes user accounts/persistence,
  and a device-session system edges toward that); this is a known,
  documented gap rather than a silent one.
- `server/uploads/` only grows unboundedly if a room is somehow deleted
  through a path that bypasses `roomManager.js`'s deletion listener (there
  isn't one - `leaveRoom`'s grace-period expiry is the only deletion path,
  and it always fires `onRoomDeleted`). Normal track replacement within a
  live room already cleans up the prior file (Phase 2), and Phase 6 closed
  the room-deletion gap that used to leave an orphaned file behind.
- Multer 1.x was initially installed by mistake (deprecated/vulnerable);
  corrected to Multer `^2.2.0` before first use — no vulnerable version ever
  ran with real uploads enabled.
- The actual "audio stops immediately on disconnect" behavior
  (`resetPlaybackEngine()` calling `AudioBufferSourceNode.stop()`) can only
  be verified in a real browser - `getAudioContext()` requires `window`,
  which doesn't exist under Node, so it's structurally untestable with this
  project's `node --test` setup (consistent with every other AudioContext-
  touching function since Phase 0). What IS scripted-test-covered: the
  server-side guarantee that a participant's disconnect never alters
  authoritative playback or triggers a pause
  (`server/test/disconnectRecovery.test.js`), and the client-side pure
  position-calculation fix (`recoveryState.unit.test.mjs`). The actual local
  audio stop must be confirmed by ear/eye per the manual verification steps.
- Same limitation applies to the new `onended` handler
  (`playbackEngine.js`): its guard logic (only clean up if still the current
  source) can't be exercised under Node (`getAudioContext()` needs
  `window`), so it's verified by code inspection and manual browser testing
  (Test A's "no further drift correction" step), not a scripted test. What
  IS scripted-test-covered is everything server-side (the actual authority
  for natural completion) and the client-side pure position/clamp math.
- The server's end timer fires based on absolute server wall-clock time
  (`endServerTime`); each client's local audio was independently scheduled
  to stop at that same server instant via its own Phase 3 clock-offset
  estimate. Any residual mismatch between "local audio actually stops" and
  "server broadcasts completion" is bounded by that client's normal
  clock-sync accuracy - not a new source of imprecision introduced by this
  fix, just the same tolerance that already governs regular play/pause/seek.
- Track-to-track transitions (Phase 6.2A) are NOT sample-perfect gapless -
  every transition (manual Next or automatic advance) goes through the same
  ~1000ms future-scheduling lead every other playback command uses, so
  there's a short, deliberate, server-broadcast gap between tracks rather
  than zero-gap playback. Explicitly out of scope per the brief
  ("correct synchronization is more important than zero-gap playback").
- Client-side next-track preload only ever holds ONE buffer ahead
  (`queue[0]`), by design (bounded memory use per the spec) - queue items
  beyond the immediate next are not fetched/decoded until they themselves
  become `queue[0]`, so a transition two-or-more tracks deep into the queue
  always incurs a fresh download for that track, same as any first-time
  current-track decode.
- Room-deletion file cleanup (both the current track and every queued file)
  is verified in-process at the `roomManager.js` level - the deleted room
  object retains its full `track`/`queue` with `storedFilename`s intact at
  the moment `onRoomDeleted` fires (`server/test/queueManager.test.js`).
  It is NOT verified end-to-end against the live server with real
  `fs.existsSync` checks, because `setRoomCleanupGraceMsForTesting` only
  overrides the roomManager module instance inside the TEST process, not the
  one running inside the separate `node index.js` server process - there is
  no way to force the live server's real ~30s grace period to expire quickly
  without actually waiting it out. `index.js`'s actual `fs.unlink` loop
  consuming that room-deletion data is a direct, trivially-inspectable
  few-line consequence of it (the same trust boundary the original Phase 6
  onRoomDeleted current-track-only cleanup was never fs-tested end-to-end
  under either, for the same reason). Manual Next's and natural-completion's
  file cleanup (which run inside a live request/timer, not behind the grace
  period) ARE verified end-to-end with real `fs.existsSync` checks.
- The "X/Y devices" next-track-ready readout (`QueuePanel.jsx`) only counts
  devices that have both enabled audio and finished decoding `queue[0]` -
  same convention as the existing current-track READY badge (a device that
  hasn't clicked "Enable Audio" yet never counts as ready for anything).
- There is no production static-file pipeline serving the built React client
  (`client/dist/`, from `npm run build`) from the Express server -
  `server/index.js` only serves `server/public` (the Phase 0 PoC) and
  `server/uploads`. Local development (two processes: `npm run dev` in
  `client/`, `npm start` in `server/`) is fully covered; wiring Express to
  serve `client/dist` with an SPA fallback for `/room/<code>` is left as an
  explicit deployment step (see README), not something this MVP automates.
- `client/`'s pinned `vite@^5.4.11` (see the earlier "React client
  scaffolded with Vite" decision - `vite@8`'s native binding is broken on
  this Windows/Node 20.12.2 combination) carries a known `npm audit`
  advisory (moderate, via a transitive `esbuild` version) affecting only the
  Vite DEV SERVER accepting cross-origin requests - it does not affect the
  production build output or the Express server. `npm audit fix --force`
  would upgrade to the broken `vite@8`, so it's deliberately not applied;
  revisit alongside the existing "revisit only if the team upgrades Node"
  note.
- `docs/benchmarks.md` and `docs/cv-metrics.md` are structure-only as of this
  writing - every numeric field is `TO_BE_MEASURED`, pending a dedicated
  real multi-device benchmark session per the procedure documented there.
  Nothing in this project currently claims a measured drift/recovery number.

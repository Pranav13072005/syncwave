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
  clients: Map<socketId, {id, name, isHost, rtt, clockOffsetMs, syncStatus, driftMs, driftCorrectionCount}>,
  track: null | { version, originalName, mimeType, size, url, storedFilename, uploadedAt, durationSec? },
  readyDevices: Set<socketId>,  // devices that decoded `track` at its current version
  playback: { status: 'playing'|'paused', positionSec, anchorServerTime, version, trackVersion },
}
```
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
- `room:join` (client→server, ack) — `{ roomCode, name }` in, ack `{ ok, state }` or `{ ok: false, error: 'ROOM_NOT_FOUND' }`.
- `room:leave` (client→server, ack) — no payload; ack `{ ok: true }`. Also triggered implicitly by socket `disconnect`.
- `room:update` (server→room) — broadcast to all sockets in the room whenever membership, host, track, or ready state changes; full `state` payload (not a diff).

Phase 2 track events (`server/trackHandlers.js`, `server/uploadRoute.js`, `client/src/audioEngine.js` + `TrackPanel.jsx`):
- `track:requestUploadToken` (client→server, ack) — no payload; ack `{ ok: true, token }` only if the requesting socket is the room's current host, else `{ ok: false, error: 'NOT_HOST' | 'NO_ROOM' }`. Token is single-use, 30s TTL (`server/uploadTokens.js`).
- `POST /api/upload` (HTTP, not a socket event) — header `x-upload-token`, multipart field `file` (Multer, disk storage, 25MB limit, `.mp3`/`.wav` extension filter). Requires a valid token from the step above. On success, updates the room's track (bumping `track.version`, clearing `readyDevices`), deletes the previous track's file, responds `{ ok: true, track }`, and broadcasts `room:update`. Errors: `403 INVALID_TOKEN`, `400 INVALID_FILE_TYPE`, `413 FILE_TOO_LARGE`, `400 NO_FILE`, `404 ROOM_NOT_FOUND`.
- `GET /uploads/<storedFilename>` — static file serving of the current/past uploaded tracks.
- `track:ready` (client→server, ack) — `{ version }` in; only accepted if it matches the room's current `track.version` (stale acks from a slow decode of a superseded track are silently ignored). On success, adds the socket to `readyDevices` and broadcasts `room:update`.

Phase 3 clock-sync events (`client/src/clockSync.js`, `client/src/components/Diagnostics.jsx`, `server/clockHandlers.js`):
- `clock:ping` (client→server, ack) — unchanged from Phase 0; now also the low-level primitive the Phase 3 protocol samples 9 times per sync round.
- `clock:report` (client→server, ack) — `{ rtt, offsetMs, status }` in (the client's own robust estimate); ack `{ ok }`. Stores the result on the reporting client's room entry and broadcasts `room:update`; `{ ok: false }` (no-op) if the socket isn't currently in a room (e.g. mid-reconnect, before Phase 6 re-join exists).

Phase 4 playback events (`server/playbackHandlers.js`, `client/src/playbackEngine.js` + `PlaybackControls.jsx`):
- `playback:play` (client→server, ack) — no payload. Host-only. Resumes from the current canonical position (whatever it is) at a future `targetServerTime`; ack `{ ok: false, error: 'NOT_HOST' | 'NO_ROOM' | 'NO_TRACK' }` on rejection.
- `playback:pause` (client→server, ack) — no payload. Host-only. Freezes the canonical position (extrapolated to the future target time) at a future `targetServerTime`.
- `playback:seek` (client→server, ack) — `{ positionSec }` in. Host-only. Sets the canonical position at a future `targetServerTime`, preserving whatever the current status was. Rejects `INVALID_SEEK_POSITION` (non-finite/negative) or `SEEK_OUT_OF_RANGE` (beyond the track's known `durationSec`, once reported).
- All three broadcast the updated state via the existing `room:update` (not a separate event — see "Important decisions" for why) with the new `playback` object, which clients apply only if `playback.version` is strictly newer than the last version they applied.
- `track:ready` (extended from Phase 2) now also accepts `durationSec` (the decoded `AudioBuffer.duration`), stored on `room.track.durationSec` (overwritten by each reporting client - harmless since all clients decode the same file) - enables real seek-range validation.

Phase 5 drift events (`server/driftHandlers.js`, `client/src/driftMonitor.js` + `Room.jsx`):
- `playback:driftReport` (client→server, ack) — `{ driftMs, correctionCount }` in (this client's latest self-measured drift and cumulative correction count for the current track); ack `{ ok }`. Stores it on the reporting client's room entry and broadcasts `room:update`, same no-op-if-no-room policy as `clock:report`. Purely informational, never used to derive authoritative state.

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
- Host disconnect: `hostId` is set to `null` (no auto-promotion). Deliberately
  minimal — full reassignment/pause policy is Phase 6 scope; documented here
  so it isn't mistaken for a bug.
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
- Reconnection triggers a re-sync (`socket.io.on('reconnect', ...)`), but a
  reconnect gets a brand-new `socket.id` and Socket.IO does not auto-rejoin
  rooms - so post-reconnect, local diagnostics correctly update, but
  `clock:report` will find no room server-side and no-op (`{ok:false}`)
  until Phase 6 implements room re-join on reconnect. This is a real gap but
  intentionally not fixed here (Phase 6 owns reconnection/room-membership).
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
- A device with no clock-sync estimate yet (`getClockOffsetMs()` returns
  `null`) falls back to `offsetMs = 0` for scheduling rather than refusing to
  play - a `console.warn`-documented best-effort degradation (assumes clocks
  are reasonably close, often true on a LAN) rather than a new UI state,
  since "block playback entirely until synced" felt like the wrong tradeoff
  for a device that just hasn't finished its first sync round yet.
- `PlaybackControls` shows a live-ish extrapolated position (`~12.3s`,
  updated every 250ms via `setInterval` while playing) using the exact same
  extrapolation formula as the server's `getCanonicalPosition`, but this is
  cosmetic display only - it never feeds back into scheduling and is not
  drift measurement/correction (that's Phase 5's explicit scope; this is
  just "don't show a frozen number while audio is audibly playing").
- Server test suite added at `server/test/` (`node --test`, matching the
  client's Phase 3 approach): `socket.io-client` added as a devDependency
  (server itself doesn't need it) purely for the integration tests.
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

## Known issues
- The real app's clock-offset estimate (Phase 3) is robust (9-sample,
  low-RTT/median filtered). The Phase 0 PoC's original single-sample
  estimate still exists untouched in `server/public/client.js`, but that's a
  standalone demo page, not the real app path.
- No reconnection/late-join state sync yet (a client that refreshes mid-room
  loses its local view and must rejoin manually) — Phase 6 scope. Note: a
  fresh join/rejoin DOES already receive the current track in its join ack,
  so track preload on (re)join works; only playback-position sync is
  missing, and that doesn't exist yet regardless (Phase 4). Clock sync
  itself DOES re-run correctly after a Socket.IO reconnect, but the
  resulting `clock:report` silently no-ops server-side until Phase 6 makes
  reconnected sockets rejoin their room.
- Drift measurement/correction (Phase 5) is per-device and local only - it
  does not adjust playback rate (no time-stretching/resampling), does not
  calibrate for hardware/output-device latency, and does not coordinate
  across devices beyond each one independently tracking the same
  authoritative timeline. Explicitly deferred per the Phase 5 brief.
  `PlaybackControls`'s position display remains cosmetic/independent of the
  actual drift-correction machinery (separate, simpler extrapolation, no
  measurement or correction tied to it).
- No purpose-built late-join mid-playback synchronization, no reconnect
  recovery yet — Phase 6. What Phase 4 does handle: a client joining a room
  where playback is already `'playing'` receives the current `playback`
  state in its join ack; once it enables audio and finishes decoding, the
  playback-application effect schedules it correctly - `anchorServerTime` is
  in the past by then, so Web Audio clamps to `ctx.currentTime` and it just
  starts immediately at roughly the extrapolated-forward offset (see
  `getCanonicalPosition`/`schedulePlay`'s `Math.max(ctx.currentTime, ...)`
  clamps). A command that arrives before this device has decoded the
  relevant track version is held pending (not dropped) and retried once
  decode catches up (`decodedVersion` in `Room.jsx`) - this also covers the
  more common Phase 4 case of a host clicking Play before their own device
  finishes decoding a just-uploaded track. What's still missing for a truly
  precise late join: no "seek to the exact current position on join" fast
  path, so there's a decode-time gap where a joining device is silent while
  everyone else is already mid-track. Phase 6 is where this gets solved
  properly.
- Host disconnect leaves the room hostless rather than promoting another
  client — deliberate for now, see "Important decisions"; Phase 6 will
  decide the real policy. Note: this also means uploads pause until a new
  host exists, since only the host can request an upload token.
- `server/uploads/` grows by one file per track replacement within a room's
  lifetime beyond the currently-referenced one only if a room is deleted
  mid-upload-cycle edge case; normal replace-in-place already cleans up the
  prior file. Acceptable for MVP (process-lifetime storage, no persistence).
- Multer 1.x was initially installed by mistake (deprecated/vulnerable);
  corrected to Multer `^2.2.0` before first use — no vulnerable version ever
  ran with real uploads enabled.

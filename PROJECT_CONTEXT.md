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
  clients: Map<socketId, {id, name, isHost}>,
  track: null | { version, originalName, mimeType, size, url, storedFilename, uploadedAt },
  readyDevices: Set<socketId>,  // devices that decoded `track` at its current version
}
```
Public form sent to clients (`toPublicState`): `{ roomCode, hostId, track, clients: [{id, name, isHost, isReady}] }`.
`playing, position, positionServerTime, version` (playback state/version,
distinct from `track.version`) are NOT added yet — they arrive in Phase 4.

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

## Synchronization algorithm (current state)
- Clock offset: single round-trip Cristian's algorithm sample
  (`offset = serverTime + RTT/2 - clientReceiveTime`). Phase 3 upgrades this
  to 8–10 samples with low-RTT/median filtering.
- Scheduling: server broadcasts a future `targetServerTime` (now + 1000ms
  lead). Client converts to local delay via its offset estimate and calls
  `source.start(audioCtx.currentTime + delaySec)`. No immediate `.play()`
  calls anywhere.
- No versioning, no drift correction, no room state yet — those are Phases
  4–5.

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

## Known issues
- Offset estimate is single-sample and noisy — expected, fixed in Phase 3.
- No reconnection/late-join state sync yet (a client that refreshes mid-room
  loses its local view and must rejoin manually) — Phase 6 scope. Note: a
  fresh join/rejoin DOES already receive the current track in its join ack,
  so track preload on (re)join works; only playback-position sync is
  missing, and that doesn't exist yet regardless (Phase 4).
- No drift correction, no playback state yet — Phases 4-5.
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

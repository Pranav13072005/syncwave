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
- Uploads: Multer (not yet added — Phase 2)

## Architecture
Server is authoritative for room and playback state. Clients never decide
playback state independently — they only convert server-issued timestamps
into local scheduling.

## Room-state model
Implemented in `server/roomManager.js` (in-memory `Map<roomCode, room>`, no
persistence). Current shape:
`{ code, hostId, clients: Map<socketId, {id, name, isHost}> }`
Public form sent to clients (`toPublicState`): `{ roomCode, hostId, clients: [...] }`.
`track, readyDevices, playing, position, positionServerTime, version` are
NOT added yet — they arrive in Phases 2 and 4 when needed, to avoid unused
fields.

## Socket-event contract
Phase 0 PoC events (still live, untouched, served at `server/public/*`):
- `clock:ping` (client→server, ack) — `clientSendTime` in, `{ serverTime, clientSendTime }` ack out.
- `poc:requestPlay` (client→server) — any client may trigger; no host concept.
- `poc:scheduledPlay` (server→all clients) — `{ targetServerTime, startOffsetSec }`.

Phase 1 room events (real app, `server/roomHandlers.js` + `client/src/components/*`):
- `room:create` (client→server, ack) — `{ name }` in, ack `{ ok, state }` where `state = { roomCode, hostId, clients }`. Creator becomes host.
- `room:join` (client→server, ack) — `{ roomCode, name }` in, ack `{ ok, state }` or `{ ok: false, error: 'ROOM_NOT_FOUND' }`.
- `room:leave` (client→server, ack) — no payload; ack `{ ok: true }`. Also triggered implicitly by socket `disconnect`.
- `room:update` (server→room) — broadcast to all sockets in the room whenever membership or host changes; full `state` payload (not a diff).

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
- Vite dev server proxies `/socket.io` (with `ws: true`) to `localhost:3001`
  so the browser only ever talks to one origin; no CORS config needed on the
  Express server.

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

## Known issues
- Offset estimate is single-sample and noisy — expected, fixed in Phase 3.
- No reconnection/late-join state sync yet (a client that refreshes mid-room
  loses its local view and must rejoin manually) — Phase 6 scope.
- No drift correction, no playback state yet — Phases 4-5.
- Host disconnect leaves the room hostless rather than promoting another
  client — deliberate for now, see "Important decisions"; Phase 6 will
  decide the real policy.

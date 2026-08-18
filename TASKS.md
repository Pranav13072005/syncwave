# SyncWave — Tasks

## DONE
- Phase 0: Socket.IO connection PoC, shared local test audio, single-sample
  clock offset, future-server-time scheduled Web Audio playback across
  multiple clients. Manually verified via two-client smoke test and browser.
- Phase 1: React (Vite) client scaffolded; `server/roomManager.js` +
  `server/roomHandlers.js` for room create/join/leave and host tracking;
  Landing/Room/DeviceList components; room state broadcast on
  join/leave/host-disconnect. Verified via scripted two/three-client
  Socket.IO smoke tests (create, join, bad-code error, leave broadcast,
  host-disconnect nulling hostId) — see verification steps in chat. Not yet
  manually verified in an actual browser by the devs.

## CURRENT
- Awaiting manual browser verification of Phase 1 (two tabs: create room,
  join with code, confirm device list + host badge update live), then start
  Phase 2: audio upload, serving, decode/preload, per-device READY state.

## NEXT
- Phase 2: Audio upload (Multer), serving, decode/preload, per-device READY
  state.
- Phase 3: Robust 8–10 sample clock-offset estimation + diagnostics UI.
- Phase 4: Authoritative server playback state, versioned play/pause/seek,
  scheduled execution on clients.
- Phase 5: Periodic drift measurement + threshold-based correction.
- Phase 6: Late join, reconnect handling, host-disconnect behavior.
- Phase 7: Benchmarks, automated tests, error handling, README, UI polish.

## OPTIONAL
- Playback-rate based drift correction (only after basic correction works).
- Reconnect/network resilience stress testing across real devices.

# SyncWave — Tasks

## DONE
- Phase 0: Socket.IO connection PoC, shared local test audio, single-sample
  clock offset, future-server-time scheduled Web Audio playback across
  multiple clients. Manually verified via two-client smoke test and browser.
- Phase 1: React (Vite) client scaffolded; `server/roomManager.js` +
  `server/roomHandlers.js` for room create/join/leave and host tracking;
  Landing/Room/DeviceList components; room state broadcast on
  join/leave/host-disconnect. Manually verified in-browser (two tabs) —
  confirmed stable.
- Phase 2: Host-only audio upload (Multer 2.x, MP3/WAV, 25MB limit) gated by
  a server-issued upload token (not a client-claimed identity, since
  `hostId` is already visible to every client); `server/uploadRoute.js`,
  `server/trackHandlers.js`, `server/uploadTokens.js`; room state extended
  with `track` + `readyDevices`; `TrackPanel` upload UI; `audioEngine.js` +
  auto-decode effect in `Room.jsx` with explicit "Enable Audio" gesture,
  version-checked `track:ready`, READY badges, retry-on-error. Verified via
  a 17-point scripted Socket.IO + HTTP smoke test (host-only token issuance,
  bad file type/token rejection, upload success + broadcast, byte-identical
  download, stale-ready rejection, ready broadcast, replace-track version
  bump + ready-state clear + old-file cleanup). Web Audio decode itself
  requires a real browser — not yet manually verified by the devs.

## CURRENT
- Awaiting manual browser/device verification of Phase 2 (see checklist in
  chat: upload as host, confirm both tabs auto-download+decode+go READY,
  replace track, invalid file type, oversized file), then start Phase 3:
  robust clock-offset estimation + diagnostics UI.

## NEXT
- Phase 3: Robust 8–10 sample clock-offset estimation + diagnostics UI.
- Phase 4: Authoritative server playback state, versioned play/pause/seek,
  scheduled execution on clients.
- Phase 5: Periodic drift measurement + threshold-based correction.
- Phase 6: Late join, reconnect handling, host-disconnect behavior.
- Phase 7: Benchmarks, automated tests, error handling, README, UI polish.

## OPTIONAL
- Playback-rate based drift correction (only after basic correction works).
- Reconnect/network resilience stress testing across real devices.

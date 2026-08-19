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
  bump + ready-state clear + old-file cleanup). Manually verified in-browser
  by the devs — confirmed working (including a real upload left in
  `server/uploads/`).
- Phase 3: Robust 9-sample clock-offset estimation (`client/src/clockSync.js`),
  reusing the existing `clock:ping` primitive; lowest-RTT-half + median
  filtering; graceful timeout/failure handling; `Diagnostics` panel (status,
  RTT, offset, sample count, manual re-sync) triggered on room join and on
  Socket.IO reconnect; server-side per-client RTT/offset/status storage
  (`server/clockHandlers.js`) broadcast via `room:update`, surfaced as a
  compact RTT readout in the device list. Permanent scripted test suite
  added at `client/test/` (`node --test`, no new dependency): 4 unit tests
  on the pure filtering/median math, 4 integration tests against the live
  server — all 8 passing. Manually verified in-browser by the devs.
- Phase 4: Authoritative per-room playback state (`server/roomManager.js`:
  `status`, `positionSec`, `anchorServerTime`, `version`, `trackVersion`);
  host-only `playback:play`/`pause`/`seek` (`server/playbackHandlers.js`)
  with future-scheduled `anchorServerTime`, server-side host/track/seek-range
  validation; canonical position correctly maintained for both playing
  (extrapolated) and paused (frozen) states; monotonic version bumped by
  every command and by track replacement; client `playbackEngine.js`
  converts server time to local `AudioContext` scheduling via the Phase 3
  offset, one fresh `AudioBufferSourceNode` per play/seek, synchronized
  stop-old/start-new at the same instant; `PlaybackControls` UI; a pending
  (not dropped) command is retried once this device's decode catches up -
  covers both late join and a host clicking Play before their own decode
  finishes. New `server/test/` suite (`node --test`, `socket.io-client`
  devDependency): 14 unit + 5 integration tests. Client: 4 new unit tests.
  Total 24 new scripted tests (31 across the project). Manually verified
  in-browser by the devs.
- Phase 5: Periodic (2s) drift measurement while playing
  (`client/src/driftMonitor.js` pure functions + `Room.jsx`); expected
  position from authoritative state + Phase 3 offset vs. actual position from
  a new Web Audio scheduling anchor in `playbackEngine.js`; 80ms threshold,
  2 consecutive violations required, 5s cooldown after correcting; corrections
  reuse the existing seek-scheduling mechanism with a short local lead
  (150ms, no network round trip needed); correction count tracked per-track;
  drift/corrections surfaced in `Diagnostics` + optional device-list readout;
  reported to server via `playback:driftReport`
  (`server/driftHandlers.js`). 27 new scripted tests (20 drift-monitor unit +
  3 playback-engine anchor unit + 4 server integration) - 58 total across the
  project, all passing. Manually verified in-browser by the devs.
- Phase 6: Prerequisite-driven recovery (`client/src/recoveryState.js`) - one
  mechanism now covers both late join and Socket.IO reconnect: nothing is
  scheduled until room-joined + latest-state + track-decoded + clock-synced
  ALL hold, and only the newest pending authoritative state is ever applied
  (never queued). The 0ms clock-offset fallback is removed from the
  production scheduling path (main playback apply AND drift correction both
  now wait for a real completed sync). `Room.jsx` auto-rejoins on reconnect
  using the remembered room code/name. Server: deterministic host promotion
  (longest-connected remaining member) on host disconnect; `isHost` now
  computed from `room.hostId` (was a stale-prone stored field); a former
  host reconnecting returns as an ordinary participant, and their old upload
  token is rejected at consumption time if host ownership changed;
  empty rooms get a `.unref()`'d ~30s grace period before deletion (rejoin
  cancels it and restores the room, making the rejoiner host), with final
  deletion purging upload tokens and the track file. 36 new scripted tests
  (13 recovery-state unit + 3 driftMonitor gate + 1 clockSync pub/sub +
  19 server: host reassignment, former-host token rejection, room cleanup
  grace period, duplicate-member prevention, late-join/reconnect data flow) -
  94 scripted tests total across the whole project, all passing. Real
  multi-device (laptop/phone) manual verification not yet done by the devs.

## CURRENT
- Awaiting manual laptop/phone verification of Phase 6 (see checklist in
  chat: late join mid-playback adopts the current position, late join while
  paused stays silent at the right position, killing/restoring Wi-Fi on one
  device triggers automatic rejoin + resync, host disconnect promotes
  another device and the old host returns as a normal participant on
  reconnect, an empty room survives a quick rejoin but is gone after ~30s),
  then start Phase 7: benchmarks, automated tests, error handling, README,
  UI polish.

## NEXT
- Phase 7: Benchmarks, automated tests, error handling, README, UI polish.

## OPTIONAL
- Playback-rate based drift correction (only after basic correction works).
- Reconnect/network resilience stress testing across real devices.

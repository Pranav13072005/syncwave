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
  94 scripted tests total across the whole project, all passing.
- Phase 6 bugfix round: real laptop/phone testing found (1) late join
  audibly starting at track position 0 for 1-2s before the drift monitor
  corrected it, and (2) a disconnected participant's local audio continuing
  to play instead of stopping. Fixed: `computeScheduledPlayingState`
  (`client/src/recoveryState.js`) now recalculates the actual position at
  the real scheduling moment (reusing `computeExpectedPositionSec`, not a
  duplicate formula) instead of passing through the original command's
  stale snapshot; confirmed via grep that no other `schedulePlay` call site
  bypasses `recoveryState.js`. `resetPlaybackEngine()` (already existed for
  "leave room") is now also called from the socket `disconnect` handler and
  a new `window` `offline` listener, stopping local audio immediately
  without touching authoritative state or broadcasting a pause; `clockSynced`
  drops immediately on disconnect too, which also halts drift correction
  during the disconnected/recovering window. 9 new scripted tests (7 client:
  exact late-join position formula, significant-elapsed-period late join,
  no-schedule-before-all-prerequisites, no-position-0 late join, prompt-
  client-unaffected regression, duration clamping, reconnect resuming from
  the recalculated position; 2 server: no room-wide pause from a participant
  disconnect, reconnect resumes from the authoritative CURRENT position
  after the host changed it mid-disconnect) - 103 scripted tests total, all
  passing. The actual local-audio-stop-on-disconnect behavior itself can only
  be verified in a real browser (no `window`/AudioContext under Node, same
  limitation as all Web-Audio-touching code since Phase 0).
- Phase 6.1 bugfix round (playback lifecycle): real-device testing found the
  authoritative timeline/UI kept advancing past a track's natural end even
  though the local audio had already stopped. Fixed: canonical/expected-
  position calculations are now clamped to `[0, durationSec]` everywhere
  (server `getCanonicalPosition`; client `computeExpectedPositionSec`, now
  the one shared helper - also deduped `PlaybackControls`'s previously
  separate display formula into it); a new server-side end timer
  (`server/roomManager.js`) transitions authoritative playback to `paused`
  at exactly `durationSec` when a track naturally finishes, protected
  against stale firing by room/playback-version/track-version checks, and
  (re)scheduled or cancelled on every Play/Pause/Seek/track-replacement/
  room-deletion; broadcasts via a new `onPlaybackCompleted` listener
  (mirrors `onRoomDeleted`); Play after completion restarts from 0 using the
  same future-scheduled mechanism; `playbackEngine.js` gained a guarded
  `onended` for local-only cleanup (never emits, never touches authoritative
  state). No new `'ended'` status - late-join/reconnect-after-completion and
  drift-stopping needed zero new client code since completion is just a
  normal paused state. 18 new scripted tests (12 server, 6 client) - 121
  scripted tests total across the whole project, all passing.
- Phase 6.2A: server-authoritative song queue, next-track preloading,
  host-controlled Next, and synchronized automatic transition between
  tracks. `room.queue[]` with a stable per-file `trackId` (separate from the
  existing `track.version`); a second upload now queues instead of
  replacing the current track; host-only `queue:remove`/`queue:reorder`/
  `queue:next`; manual Next and automatic advance (queue non-empty at
  natural completion) share one function that reuses the Phase 6.1 end-timer
  architecture as-is (no new stale-protection mechanism needed); client
  preloads only `queue[0]` into a second buffer and promotes it (no
  re-download) when it becomes current, via the existing Phase 6 recovery/
  apply path with zero new client scheduling code; an unready device stays
  silent and recovers automatically once decoded; queue-only mutations
  (add/remove/reorder not touching `queue[0]`) never disturb current
  playback; file cleanup extended to cover queued files. New `QueuePanel`
  UI (Up Next list, host Add/Remove/Move/Next controls, compact next-ready
  readout). 32 new scripted server tests (22 direct roomManager unit tests +
  10 live-server integration tests) - 153 scripted tests total across the
  whole project, all passing.
- Phase 6.2A.1 reliability fixes: investigated multi-device join slowdown and
  a stale-old-track-on-unready-Next bug per the brief before changing code.
  Found `Room.jsx`'s effects were already correctly keyed on primitive
  version fields (not accidentally re-triggered by membership-only
  updates) - the real join-burst issue was async races: `clockSync.js`
  gained a monotonic generation guard so an older, slower `runClockSync`
  call can never overwrite a newer one's result; `Diagnostics.jsx` gained an
  in-flight-sync guard; `audioEngine.js`'s `decodeTrackFromUrl` gained an
  in-flight-promise cache keyed by url; `recoveryState.js`'s local
  scheduling lead raised 150ms -> 300ms. The stale-track bug: the
  recovery-apply effect's "not decoded yet" branch never called
  `schedulePause`, so an unready device's OLD source just kept playing.
  Fixed by tracking `currentTrackVersion` in `playbackEngine.js`
  (`getCurrentTrackVersion()`) and adding a separate `Room.jsx` effect that
  retires a stale source at the authoritative transition instant regardless
  of buffer readiness - decoupled from starting the new track, which stays
  gated on `trackDecoded`. 6 new scripted tests - 159 scripted tests total,
  all passing.
- Phase 6.2B final product features: Primary Host + Co-hosts
  (`room.coHostIds`, promote/demote/transfer, failover prefers a co-host,
  `requireController` broadens playback/queue authorization to
  primary-or-co-host); local volume (persistent `GainNode`, survives source
  recreation); device calibration (`calibrationOffsetMs`, separate from
  network clock offset, localStorage-persisted); Screen Wake Lock
  (feature-detected, reacquires on visibility change); invite links
  (`/room/<CODE>`, no router dependency); queue UI polish (Now
  Playing/Up Next headings). 22 new scripted tests - 181 scripted tests
  total, all passing.
- Phase 7 final engineering pass: responsive layout reorder + mobile
  breakpoint; top-level `ErrorBoundary`; one real listener-cleanup fix
  (`InvitePanel.jsx`'s copy-confirmation timeout); env-var overrides for
  server port/upload limit/Vite proxy target, all with working defaults;
  a development/benchmark facility (`client/src/benchmark.js` +
  `BenchmarkPanel.jsx`) collecting real join/reconnect recovery times and
  drift-sample aggregates, never fabricated; duplicated integration-test
  helpers extracted to `server/testUtils.js`; Phase 0 PoC page labeled more
  explicitly; `docs/benchmarks.md` + `docs/cv-metrics.md` created with
  `TO_BE_MEASURED` placeholders only; full README with architecture +
  sequence Mermaid diagrams. 8 new scripted tests - **189 scripted tests
  total across the whole project (110 server + 79 client), all passing.**

## CURRENT
**FEATURE COMPLETE — AWAITING FINAL REAL-DEVICE DEBUG/BENCHMARK PASS.**

Everything through Phase 7 is implemented and covered by the automated test
suite (189/189 passing) and both production builds succeed. Still pending
before the project can be called fully finished:
- The full manual real-device verification checklist (see the final report
  delivered in chat, section E) - normal Play/Pause/Seek, 3+ participants
  joining, queue, manual/automatic Next, a slow/unready device, late join,
  airplane-mode disconnect/reconnect, host failover, co-host controls, host
  transfer, volume, calibration, Wake Lock, track completion/replay.
- The Phase 6.1/6.2A queue manual verification checklists from the previous
  rounds (Tests A-D playback lifecycle; Tests A-G queue) remain unconfirmed
  from a real-device pass and are folded into the consolidated checklist
  above rather than tracked separately from here on.
- Running the `docs/benchmarks.md` procedure on real devices and filling in
  its (currently `TO_BE_MEASURED`) numbers, then updating
  `docs/cv-metrics.md` from those results.

## NEXT
- Real-device debugging + benchmark pass (see above). No further feature
  work is planned per the Phase 7 brief's scope freeze - do not add Spotify/
  YouTube/Apple Music, WebRTC/peer-to-peer streaming, chat, social profiles,
  recommendations, an AI DJ, a native mobile app, a database for its own
  sake, or microservices/Kubernetes.

## OPTIONAL
- Playback-rate based drift correction (only after basic correction works).
- Reconnect/network resilience stress testing across real devices.
- Wiring a production static-file pipeline (Express serving `client/dist`
  with an SPA fallback for `/room/<code>`) if/when an actual deployment is
  needed - not required for local development or the CV/portfolio use case.

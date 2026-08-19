# SyncWave — Benchmarks

Status: **structure only — no real-device measurements have been entered yet.**
Every numeric field below is marked `TO_BE_MEASURED`. Do not replace them with
invented numbers; fill them in only after actually running the procedure in
this document on real devices, using the in-app Benchmark Panel
(`client/src/benchmark.js` + `BenchmarkPanel.jsx`, a collapsed "Benchmark
data" section under Sync Diagnostics in the Room view).

All drift numbers in this document are **client-reported playback drift** —
each device's own estimate of `actual position - expected position` in Web
Audio time, computed locally (see PROJECT_CONTEXT.md's "Synchronization
algorithm" section). They are *not* an acoustic/physical measurement of when
sound actually left the speaker. Section 5 below covers the optional acoustic
method and how to keep the two clearly distinguished if it's ever performed.

## 1. Test setup template

Fill in for each benchmark session:

| Field | Value |
|---|---|
| Date | TO_BE_MEASURED |
| Network | TO_BE_MEASURED (e.g. "home Wi-Fi, 5GHz, all devices same AP") |
| Server host | TO_BE_MEASURED (e.g. "laptop on the same LAN, `node index.js`") |
| Server machine specs | TO_BE_MEASURED |
| Number of devices | TO_BE_MEASURED |

### Devices/browsers used

| Device | OS | Browser | Role (host/co-host/participant) |
|---|---|---|---|
| TO_BE_MEASURED | TO_BE_MEASURED | TO_BE_MEASURED | TO_BE_MEASURED |

## 2. Measurement definitions

These are the exact boundaries the app measures (see `client/src/benchmark.js`
for the authoritative source — this table just mirrors it):

- **Join recovery time** = from this device's `Room` component mounting
  (i.e. its `room:join`/`room:create` ack already arrived) to the first
  successful application of a recovery instruction (`recoveryState.js`'s
  `tryConsumePending` producing a non-null `toApply`) — whether that's a
  scheduled `playing` state or an adopted `paused` one. Either represents
  "this device now has valid synchronized state." A device joining a paused
  room recovers just as validly with zero audio, so this is deliberately not
  defined as "first audible sound."
- **Reconnect recovery time** = from the Socket.IO `reconnect` event firing
  to the next successful `toApply` application after that point.
- **Client-reported drift** = `computeDriftMs` output from
  `client/src/driftMonitor.js`, sampled every 2s while playing
  (`DEFAULT_MEASURE_INTERVAL_MS`). Positive = this device's local clock is
  ahead of the authoritative timeline; negative = behind.
- **Correction count** = number of times a single device's drift monitor
  actually issued a resynchronization (2 consecutive threshold violations,
  see `evaluateDriftSample`), not the number of samples taken.

## 3. Procedure

Run with 2, 3, 4, and (if available) 5 devices, repeating the same steps:

1. All devices on the same local network.
2. Each device opens the client, joins the same room, and clicks **Enable
   Audio**.
3. Wait for each device's Diagnostics panel to show `Synced`.
4. Host uploads a track; wait for every device to preload the immediate-next
   queued track too (if a queue item is used in this run).
5. Host presses **Play**; let playback run for a fixed interval (suggested
   60–120s) to accumulate drift samples.
6. Record each device's Benchmark Panel numbers (RTT, clock offset, drift
   sample count/mean/median/P95/max, correction count) into the table below.
7. Perform one **Seek**; note qualitative behavior (did all devices land
   together audibly).
8. Perform one manual **Next** (with a queued track); note whether any
   device was "unready" and had to catch up silently.
9. Disconnect one participant (airplane mode or closing Wi-Fi) and
   reconnect it; record its reconnect recovery time from the Benchmark
   Panel.
10. Add one late joiner mid-playback if a spare device is available; record
    its join recovery time.
11. Copy each device's full Benchmark Panel JSON report (the panel's "Copy
    report as JSON" button) and paste the raw values into section 4 below -
    do not hand-summarize on the fly, paste the actual numbers.

## 4. Results

### 2 devices

Status: TO_BE_MEASURED

| Device | RTT (ms) | Clock offset (ms) | Drift samples | Mean abs drift (ms) | Median abs drift (ms) | P95 abs drift (ms) | Max abs drift (ms) | Corrections | Join recovery (ms) | Reconnect recovery (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| TO_BE_MEASURED | | | | | | | | | | |

### 3 devices

Status: TO_BE_MEASURED

(same table shape as above)

### 4 devices

Status: TO_BE_MEASURED

(same table shape as above)

### 5 devices

Status: TO_BE_MEASURED (only if 5 physical devices are available)

## 5. Optional: acoustic synchronization test

Not required to consider the project complete. If performed:

1. Use the generated click/tick test track (`server/scripts/generate-tone.js`
   → `server/public/audio/test-tone.wav`, 1 audible tick/second).
2. Place all participating devices' speakers close together, near one
   external microphone/phone recording the whole session as a single audio
   file.
3. Play back the recording later and measure the time offset between each
   device's tick peaks (any audio editor with a waveform view works).
4. Report this as **measured acoustic speaker offset**, explicitly labeled
   as distinct from the client-reported drift numbers above - the acoustic
   number includes real hardware/output-path latency (DAC, Bluetooth, OS
   audio stack) that client-reported drift cannot see, since drift is
   computed purely from Web Audio's own internal clock, not from what a
   microphone actually hears.

Status: TO_BE_MEASURED / not yet performed.

## 6. Limitations of this benchmark methodology

- Client-reported drift never accounts for hardware output latency
  (speaker/DAC/Bluetooth) - only section 5's acoustic method does.
- Results depend heavily on local network conditions and are not portable
  claims about performance on an arbitrary network/WAN.
- The server used for benchmarking is not a production deployment (in-memory
  state, local file storage) - see PROJECT_CONTEXT.md/README for the full
  architecture limitations.

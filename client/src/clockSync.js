// Robust client/server clock-offset estimation (Cristian's algorithm,
// multi-sample). The server clock is authoritative. Offset convention:
//   serverTime = clientTime + offsetMs   (so clientTime = serverTime - offsetMs)
// Reuses the existing `clock:ping` ack (client sends its own send time,
// server echoes it back with its own wall-clock time) - no server protocol
// change needed for the sampling itself.
const DEFAULT_SAMPLE_COUNT = 9;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_INTER_SAMPLE_DELAY_MS = 30;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Never trusts a single sample: keeps the lowest-RTT half of the samples
// (at least 3, or all of them if fewer came back) - high-RTT samples are the
// least reliable for Cristian's symmetric-delay assumption - then takes the
// median offset/RTT among that filtered subset.
export function computeRobustEstimate(samples) {
  if (samples.length === 0) {
    return { status: 'failed', offsetMs: null, rttMs: null, sampleCount: 0 };
  }
  const sorted = [...samples].sort((a, b) => a.rtt - b.rtt);
  const keepCount = Math.min(sorted.length, Math.max(3, Math.ceil(sorted.length / 2)));
  const best = sorted.slice(0, keepCount);
  return {
    status: 'synced',
    offsetMs: median(best.map((s) => s.offset)),
    rttMs: median(best.map((s) => s.rtt)),
    sampleCount: samples.length,
  };
}

// Caches the most recent sync result at module scope so any part of the app
// (notably playbackEngine.js, which needs the offset to convert a server's
// targetServerTime into a local AudioContext delay) can read it without
// Diagnostics.jsx having to thread it through props/context.
let lastKnownOffsetMs = null;
let lastSyncStatus = 'idle';

export function getClockOffsetMs() {
  return lastKnownOffsetMs;
}

export function getLastSyncStatus() {
  return lastSyncStatus;
}

// Phase 6: lets other modules (Room.jsx's recovery-prerequisite tracking)
// react the moment a sync round finishes, without needing to own/duplicate
// the trigger themselves - Diagnostics.jsx remains the only thing that calls
// runClockSync (on mount and on Socket.IO reconnect); this just makes its
// result observable elsewhere too.
const resultListeners = new Set();

export function onClockSyncResult(listener) {
  resultListeners.add(listener);
  return () => resultListeners.delete(listener);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingOnce(socket, timeoutMs) {
  const clientSendTime = Date.now();
  const ack = await new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit('clock:ping', clientSendTime, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
  const clientReceiveTime = Date.now();
  const rtt = clientReceiveTime - clientSendTime;
  const estimatedServerTimeAtReceive = ack.serverTime + rtt / 2;
  const offset = estimatedServerTimeAtReceive - clientReceiveTime;
  return { rtt, offset };
}

// Runs `sampleCount` ping rounds, skipping (not crashing on) any that time
// out or error, then derives a robust estimate from whatever came back.
export async function runClockSync(socket, {
  sampleCount = DEFAULT_SAMPLE_COUNT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  interSampleDelayMs = DEFAULT_INTER_SAMPLE_DELAY_MS,
  onSample,
} = {}) {
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    try {
      const sample = await pingOnce(socket, timeoutMs);
      samples.push(sample);
      onSample?.(i, sample);
    } catch {
      onSample?.(i, null); // timed out / missing ack - skip this sample
    }
    if (i < sampleCount - 1 && interSampleDelayMs) {
      await sleep(interSampleDelayMs);
    }
  }
  const result = computeRobustEstimate(samples);
  lastKnownOffsetMs = result.offsetMs;
  lastSyncStatus = result.status;
  resultListeners.forEach((listener) => listener(result));
  return result;
}

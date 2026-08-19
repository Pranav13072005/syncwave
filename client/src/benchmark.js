// Phase 7: a small development/benchmark facility for collecting REAL
// numbers from real connected devices - never fabricated. Pure aggregation
// logic here (directly unit-testable, same convention as driftMonitor.js/
// clockSync.js); the module-level "Global" wrappers below are the stateful
// convenience Room.jsx actually calls, mirroring clockSync.js's
// module-level-cache pattern.
//
// Measurement boundaries (documented per the Phase 7 brief, since the
// existing architecture doesn't have a single obvious instant for either):
//   - joinRecoveryMs = from Room.jsx mounting (this device's join was
//     already acked by the time Room mounts - see initialState) to the
//     FIRST successful application of a recovery toApply (recoveryState.js),
//     whether that's a scheduled 'playing' state or an adopted 'paused'
//     one - either represents "this device now has valid synchronized
//     state", not specifically "audio is audibly playing" (a device joining
//     a paused room recovers just as validly with zero audio).
//   - reconnectRecoveryMs = from the Socket.IO 'reconnect' event firing to
//     the next successful toApply application after that point - mirrors
//     joinRecoveryMs's definition, just anchored to reconnect instead of
//     mount.
// Both use performance.now() (monotonic, immune to system clock changes),
// NOT Date.now() or server time - these are LOCAL wall-clock durations of
// "how long did MY device take", unrelated to the Phase 3 network clock
// offset.

export function summarizeAbsDrift(samples) {
  if (samples.length === 0) {
    return { count: 0, meanAbsMs: null, medianAbsMs: null, p95AbsMs: null, maxAbsMs: null };
  }
  const abs = samples.map((s) => Math.abs(s)).sort((a, b) => a - b);
  const count = abs.length;
  const meanAbsMs = abs.reduce((sum, v) => sum + v, 0) / count;
  const medianAbsMs = count % 2 === 0 ? (abs[count / 2 - 1] + abs[count / 2]) / 2 : abs[(count - 1) / 2];
  const p95Index = Math.min(count - 1, Math.ceil(0.95 * count) - 1);
  return { count, meanAbsMs, medianAbsMs, p95AbsMs: abs[p95Index], maxAbsMs: abs[count - 1] };
}

export function createBenchmarkState() {
  return {
    driftSamples: [],
    correctionCount: 0,
    joinRecoveryMs: null,
    reconnectRecoveryMsSamples: [],
  };
}

export function recordDriftSample(state, driftMs) {
  return { ...state, driftSamples: [...state.driftSamples, driftMs] };
}

export function recordCorrection(state) {
  return { ...state, correctionCount: state.correctionCount + 1 };
}

// Only the FIRST join recovery is recorded - a device only joins once per
// session; subsequent recovery events after that are reconnects, not joins.
export function recordJoinRecovery(state, ms) {
  if (state.joinRecoveryMs !== null) return state;
  return { ...state, joinRecoveryMs: ms };
}

export function recordReconnectRecovery(state, ms) {
  return { ...state, reconnectRecoveryMsSamples: [...state.reconnectRecoveryMsSamples, ms] };
}

// --- module-level convenience wrappers (what Room.jsx/BenchmarkPanel.jsx actually call) ---

let globalState = createBenchmarkState();

export function recordDriftSampleGlobal(driftMs) {
  globalState = recordDriftSample(globalState, driftMs);
}
export function recordCorrectionGlobal() {
  globalState = recordCorrection(globalState);
}
export function recordJoinRecoveryGlobal(ms) {
  globalState = recordJoinRecovery(globalState, ms);
}
export function recordReconnectRecoveryGlobal(ms) {
  globalState = recordReconnectRecovery(globalState, ms);
}
export function getBenchmarkSnapshot() {
  return globalState;
}
export function resetBenchmarkState() {
  globalState = createBenchmarkState();
}

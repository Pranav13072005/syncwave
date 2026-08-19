// Pure drift-measurement and correction-policy logic, kept free of any
// Web Audio/socket/timer side effects so it's directly unit-testable. The
// stateful wiring (setInterval, reading the audio engine, emitting to the
// server) lives in Room.jsx, which calls these functions each tick.
export const DEFAULT_DRIFT_THRESHOLD_MS = 80;
export const DEFAULT_REQUIRED_CONSECUTIVE_VIOLATIONS = 2;
export const DEFAULT_CORRECTION_COOLDOWN_MS = 5000;
export const DEFAULT_MEASURE_INTERVAL_MS = 2000;
export const DEFAULT_CORRECTION_LEAD_MS = 150; // local self-correction only, no network round trip needed

// Pure: authoritative position at a given (estimated) server time, mirroring
// server/roomManager.js's getCanonicalPosition. Only meaningful while
// playing; paused/absent playback just returns the frozen position.
// Clamped to [0, durationSec] when durationSec is known (optional 3rd
// param, omit/null for no clamp) - this is THE shared canonical-position
// helper reused by recoveryState.js's recovery math, Room.jsx's drift
// measurement/correction, and PlaybackControls.jsx's display, so clamping
// here once covers all of them rather than duplicating the bound in each.
export function computeExpectedPositionSec(playback, atServerTimeMs, durationSec = null) {
  if (!playback) return 0;
  let positionSec;
  if (playback.status !== 'playing' || playback.anchorServerTime == null) {
    positionSec = playback.positionSec;
  } else {
    const elapsedSec = Math.max(0, (atServerTimeMs - playback.anchorServerTime) / 1000);
    positionSec = playback.positionSec + elapsedSec;
  }
  positionSec = Math.max(0, positionSec);
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec >= 0) {
    positionSec = Math.min(positionSec, durationSec);
  }
  return positionSec;
}

// Pure: signed drift in ms. Positive = client is ahead of the authoritative
// timeline; negative = client is behind.
export function computeDriftMs(actualPositionSec, expectedPositionSec) {
  return (actualPositionSec - expectedPositionSec) * 1000;
}

// Pure gate: is it even meaningful to measure/correct drift right now?
// False while paused, while this device hasn't decoded the track version the
// authoritative state currently applies to (protects against acting on
// stale/superseded audio - see "Preserve playback/track versions" in the
// Phase 5 requirements), or (Phase 6) while this device has no completed
// clock sync - correction schedules real Web Audio operations from an
// offset, and a 0ms fallback there would be exactly the "production
// reliance on a 0ms fallback for synchronized execution" Phase 6 removes.
// Defaults to true so all pre-Phase-6 call sites/tests are unaffected.
export function canMeasureDrift(playback, decodedTrackVersion, hasClockSync = true) {
  if (!playback || playback.status !== 'playing') return false;
  if (decodedTrackVersion == null || decodedTrackVersion !== playback.trackVersion) return false;
  if (!hasClockSync) return false;
  return true;
}

export function createInitialDriftState() {
  return { consecutiveViolations: 0, cooldownUntilMs: null, correctionCount: 0, lastDriftMs: null };
}

// Pure state-machine step. Given the previous monitor state and a new drift
// sample (plus the current wall-clock time, passed in rather than read
// internally so this stays fully deterministic/testable), decides whether
// this sample violates the threshold, whether that's enough consecutive
// violations to correct, and whether a cooldown is still blocking correction.
// Returns the next state, with `didCorrect` indicating whether the caller
// should perform a resynchronization this tick.
export function evaluateDriftSample(prevState, driftMs, nowMs, options = {}) {
  const thresholdMs = options.thresholdMs ?? DEFAULT_DRIFT_THRESHOLD_MS;
  const requiredViolations = options.requiredConsecutiveViolations ?? DEFAULT_REQUIRED_CONSECUTIVE_VIOLATIONS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_CORRECTION_COOLDOWN_MS;

  const isViolation = Math.abs(driftMs) >= thresholdMs;
  const inCooldown = prevState.cooldownUntilMs != null && nowMs < prevState.cooldownUntilMs;
  const consecutiveViolations = isViolation ? prevState.consecutiveViolations + 1 : 0;
  const didCorrect = !inCooldown && consecutiveViolations >= requiredViolations;

  return {
    consecutiveViolations: didCorrect ? 0 : consecutiveViolations,
    cooldownUntilMs: didCorrect ? nowMs + cooldownMs : prevState.cooldownUntilMs,
    correctionCount: didCorrect ? prevState.correctionCount + 1 : prevState.correctionCount,
    lastDriftMs: driftMs,
    didCorrect,
  };
}

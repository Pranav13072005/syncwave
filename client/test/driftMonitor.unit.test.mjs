// Pure-function tests for the Phase 5 drift measurement/correction policy.
// No AudioContext/socket/timers needed. `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeExpectedPositionSec,
  computeDriftMs,
  canMeasureDrift,
  createInitialDriftState,
  evaluateDriftSample,
  DEFAULT_DRIFT_THRESHOLD_MS,
} from '../src/driftMonitor.js';

// --- computeExpectedPositionSec ---

test('computeExpectedPositionSec extrapolates forward while playing', () => {
  const playback = { status: 'playing', positionSec: 10, anchorServerTime: 1000, trackVersion: 1 };
  const pos = computeExpectedPositionSec(playback, 3500); // 2.5s after anchor
  assert.ok(Math.abs(pos - 12.5) < 0.001, `expected ~12.5, got ${pos}`);
});

test('computeExpectedPositionSec returns the frozen position while paused, regardless of "now"', () => {
  const playback = { status: 'paused', positionSec: 42, anchorServerTime: 1000, trackVersion: 1 };
  assert.equal(computeExpectedPositionSec(playback, 999999), 42);
});

test('computeExpectedPositionSec clamps to the anchor position for a time before the anchor', () => {
  const playback = { status: 'playing', positionSec: 5, anchorServerTime: 5000, trackVersion: 1 };
  assert.equal(computeExpectedPositionSec(playback, 4000), 5);
});

// --- computeDriftMs (zero / ahead / behind) ---

test('computeDriftMs is zero when actual matches expected exactly', () => {
  assert.equal(computeDriftMs(10, 10), 0);
});

test('computeDriftMs is positive when the client is ahead of the authoritative timeline', () => {
  const drift = computeDriftMs(10.2, 10.0); // actual 200ms ahead
  assert.ok(Math.abs(drift - 200) < 0.001, `expected ~200, got ${drift}`);
});

test('computeDriftMs is negative when the client is behind the authoritative timeline', () => {
  const drift = computeDriftMs(9.8, 10.0); // actual 200ms behind
  assert.ok(Math.abs(drift - -200) < 0.001, `expected ~-200, got ${drift}`);
});

// --- canMeasureDrift (paused state, stale track version) ---

test('canMeasureDrift is false while paused', () => {
  const playback = { status: 'paused', trackVersion: 1 };
  assert.equal(canMeasureDrift(playback, 1), false);
});

test('canMeasureDrift is false with no playback state at all', () => {
  assert.equal(canMeasureDrift(null, 1), false);
});

test('canMeasureDrift is false when the decoded track version does not match the authoritative one (stale/superseded audio)', () => {
  const playback = { status: 'playing', trackVersion: 2 };
  assert.equal(canMeasureDrift(playback, 1), false); // decoded v1, authoritative is v2
  assert.equal(canMeasureDrift(playback, null), false); // nothing decoded at all
});

test('canMeasureDrift is true only when playing AND the decoded track version matches', () => {
  const playback = { status: 'playing', trackVersion: 3 };
  assert.equal(canMeasureDrift(playback, 3), true);
});

// --- Phase 6: no 0ms clock-offset fallback for drift correction either ---

test('canMeasureDrift is false when the device has no completed clock sync', () => {
  const playback = { status: 'playing', trackVersion: 1 };
  assert.equal(canMeasureDrift(playback, 1, false), false);
});

test('canMeasureDrift defaults hasClockSync to true, so pre-Phase-6 call sites are unaffected', () => {
  const playback = { status: 'playing', trackVersion: 1 };
  assert.equal(canMeasureDrift(playback, 1), true); // 2-arg call, same as all existing Phase 5 tests
});

test('canMeasureDrift requires ALL three conditions - playing, matching track, and synced', () => {
  const playing = { status: 'playing', trackVersion: 1 };
  const paused = { status: 'paused', trackVersion: 1 };
  assert.equal(canMeasureDrift(playing, 1, true), true);
  assert.equal(canMeasureDrift(playing, 1, false), false);
  assert.equal(canMeasureDrift(playing, 2, true), false);
  assert.equal(canMeasureDrift(paused, 1, true), false);
});

// --- threshold boundary ---

test('a drift exactly at the threshold counts as a violation', () => {
  const state = createInitialDriftState();
  const result = evaluateDriftSample(state, DEFAULT_DRIFT_THRESHOLD_MS, 0);
  assert.equal(result.consecutiveViolations, 1);
});

test('a drift just under the threshold does not count as a violation', () => {
  const state = createInitialDriftState();
  const result = evaluateDriftSample(state, DEFAULT_DRIFT_THRESHOLD_MS - 0.1, 0);
  assert.equal(result.consecutiveViolations, 0);
});

test('threshold check uses magnitude - a large negative (behind) drift also violates', () => {
  const state = createInitialDriftState();
  const result = evaluateDriftSample(state, -DEFAULT_DRIFT_THRESHOLD_MS - 5, 0);
  assert.equal(result.consecutiveViolations, 1);
});

// --- consecutive-violation logic ---

test('a single violation does not trigger a correction (requires 2 consecutive)', () => {
  const state = createInitialDriftState();
  const result = evaluateDriftSample(state, 200, 0);
  assert.equal(result.consecutiveViolations, 1);
  assert.equal(result.didCorrect, false);
});

test('two consecutive violations trigger a correction', () => {
  let state = createInitialDriftState();
  state = evaluateDriftSample(state, 200, 0);
  const result = evaluateDriftSample(state, 210, 1000);
  assert.equal(result.consecutiveViolations, 0); // reset after correcting
  assert.equal(result.didCorrect, true);
  assert.equal(result.correctionCount, 1);
});

test('a good sample between two violations resets the consecutive counter (no correction)', () => {
  let state = createInitialDriftState();
  state = evaluateDriftSample(state, 200, 0); // violation #1
  state = evaluateDriftSample(state, 5, 1000); // fine - resets streak
  const result = evaluateDriftSample(state, 200, 2000); // violation #1 again (not #2)
  assert.equal(result.consecutiveViolations, 1);
  assert.equal(result.didCorrect, false);
});

// --- cooldown behavior ---

test('a cooldown after correcting blocks a new correction even if violations continue', () => {
  let state = createInitialDriftState();
  state = evaluateDriftSample(state, 200, 0);
  state = evaluateDriftSample(state, 200, 1000); // corrects, cooldown starts at t=1000, lasts 5000ms by default
  assert.equal(state.didCorrect, true);
  const cooldownUntil = state.cooldownUntilMs;

  // Two more consecutive violations arrive while still in cooldown.
  state = evaluateDriftSample(state, 200, 1500);
  state = evaluateDriftSample(state, 200, 2000);
  assert.equal(state.didCorrect, false, 'should not correct again while cooldown is active');
  assert.equal(state.cooldownUntilMs, cooldownUntil, 'cooldown window itself is not extended by blocked attempts');
});

test('once the cooldown expires, a persistent violation streak corrects again promptly', () => {
  let state = createInitialDriftState();
  state = evaluateDriftSample(state, 200, 0);
  state = evaluateDriftSample(state, 200, 1000); // corrects; cooldown until 1000+5000=6000
  assert.equal(state.didCorrect, true);

  // Violations keep accumulating during the cooldown window (not reset by it).
  state = evaluateDriftSample(state, 200, 3000);
  state = evaluateDriftSample(state, 200, 5000);
  assert.equal(state.didCorrect, false);
  assert.ok(state.consecutiveViolations >= 2, 'violations should keep accumulating through cooldown');

  // Cooldown has now expired (nowMs=6500 > 6000) - next violation should correct immediately.
  const after = evaluateDriftSample(state, 200, 6500);
  assert.equal(after.didCorrect, true);
  assert.equal(after.correctionCount, 2);
});

test('cooldown option is respected when explicitly configured', () => {
  let state = createInitialDriftState();
  state = evaluateDriftSample(state, 200, 0, { cooldownMs: 100 });
  state = evaluateDriftSample(state, 200, 10, { cooldownMs: 100 }); // corrects at t=10, cooldown until 110
  assert.equal(state.didCorrect, true);

  const stillInCooldown = evaluateDriftSample(state, 200, 50, { cooldownMs: 100 });
  assert.equal(stillInCooldown.didCorrect, false);

  const afterCooldown = evaluateDriftSample(stillInCooldown, 200, 150, { cooldownMs: 100 });
  assert.equal(afterCooldown.didCorrect, true);
});

// --- paused state (no violations should ever accumulate/correct while paused) ---
// canMeasureDrift already covers the gate itself; this confirms the state
// machine has no special-casing that would need "paused" - the caller in
// Room.jsx simply never calls evaluateDriftSample while canMeasureDrift is
// false, so nothing here should be invoked. Documented via canMeasureDrift
// tests above; no further evaluateDriftSample behavior is paused-specific.

// --- stale playback/track version rejection ---
// canMeasureDrift's "decoded track version mismatch" tests above cover this
// directly. Additionally: a fresh evaluateDriftSample state (as Room.jsx
// creates whenever playback.version changes) never carries over a violation
// streak from a previous/stale command.
test('a fresh drift state (as used after a new playback version arrives) starts with no violation streak', () => {
  const fresh = createInitialDriftState();
  assert.equal(fresh.consecutiveViolations, 0);
  assert.equal(fresh.cooldownUntilMs, null);
  // A single violation against the fresh state must not immediately correct,
  // proving no stale streak carried over from before the reset.
  const result = evaluateDriftSample(fresh, 500, 0);
  assert.equal(result.didCorrect, false);
});

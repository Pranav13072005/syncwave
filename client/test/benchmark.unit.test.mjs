// Pure-function tests for the Phase 7 benchmark aggregation helpers. No
// AudioContext/socket/timer needed. `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeAbsDrift,
  createBenchmarkState,
  recordDriftSample,
  recordCorrection,
  recordJoinRecovery,
  recordReconnectRecovery,
} from '../src/benchmark.js';

test('summarizeAbsDrift handles zero samples without crashing', () => {
  const result = summarizeAbsDrift([]);
  assert.deepEqual(result, { count: 0, meanAbsMs: null, medianAbsMs: null, p95AbsMs: null, maxAbsMs: null });
});

test('summarizeAbsDrift computes mean/median/p95/max of ABSOLUTE values (signed drift both directions)', () => {
  const samples = [10, -20, 30, -40, 50]; // abs: 10,20,30,40,50
  const result = summarizeAbsDrift(samples);
  assert.equal(result.count, 5);
  assert.equal(result.meanAbsMs, 30);
  assert.equal(result.medianAbsMs, 30);
  assert.equal(result.maxAbsMs, 50);
  assert.ok(result.p95AbsMs >= result.medianAbsMs, 'p95 must be at or above the median');
});

test('summarizeAbsDrift median for an even sample count averages the two middle values', () => {
  const result = summarizeAbsDrift([10, 20, 30, 40]);
  assert.equal(result.medianAbsMs, 25);
});

test('summarizeAbsDrift p95 is the max for a small sample count (matches common-sense expectation)', () => {
  const result = summarizeAbsDrift([5, 10, 15]);
  assert.equal(result.p95AbsMs, 15);
});

// --- state accumulation ---

test('recordDriftSample appends without mutating the previous state object', () => {
  const s0 = createBenchmarkState();
  const s1 = recordDriftSample(s0, 12);
  const s2 = recordDriftSample(s1, -8);
  assert.deepEqual(s0.driftSamples, []);
  assert.deepEqual(s1.driftSamples, [12]);
  assert.deepEqual(s2.driftSamples, [12, -8]);
});

test('recordCorrection increments the correction count', () => {
  let state = createBenchmarkState();
  state = recordCorrection(state);
  state = recordCorrection(state);
  assert.equal(state.correctionCount, 2);
});

test('recordJoinRecovery only records the FIRST call - a device joins once per session', () => {
  let state = createBenchmarkState();
  state = recordJoinRecovery(state, 250);
  state = recordJoinRecovery(state, 9999); // a later, spurious call must not overwrite the real join time
  assert.equal(state.joinRecoveryMs, 250);
});

test('recordReconnectRecovery accumulates one sample per reconnect (unlike join, which happens once)', () => {
  let state = createBenchmarkState();
  state = recordReconnectRecovery(state, 300);
  state = recordReconnectRecovery(state, 420);
  assert.deepEqual(state.reconnectRecoveryMsSamples, [300, 420]);
});

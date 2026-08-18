// Pure-function tests for the robust clock-offset filtering/median logic.
// No network or server needed - always safe to run. `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRobustEstimate } from '../src/clockSync.js';

test('filters out a high-RTT outlier before taking the median', () => {
  const samples = [
    { rtt: 10, offset: 5 },
    { rtt: 12, offset: 6 },
    { rtt: 11, offset: 4 },
    { rtt: 9, offset: 5 },
    { rtt: 500, offset: 900 }, // outlier: high RTT, wildly different offset
  ];
  const result = computeRobustEstimate(samples);
  assert.equal(result.status, 'synced');
  assert.equal(result.sampleCount, 5);
  assert.ok(Math.abs(result.offsetMs - 5) < 1, `offset ${result.offsetMs} should stay near the low-RTT cluster`);
  assert.ok(result.rttMs < 20, `rtt ${result.rttMs} should come from the low-RTT cluster, not the outlier`);
});

test('handles zero samples (every ping timed out) without crashing', () => {
  const result = computeRobustEstimate([]);
  assert.equal(result.status, 'failed');
  assert.equal(result.offsetMs, null);
  assert.equal(result.rttMs, null);
  assert.equal(result.sampleCount, 0);
});

test('handles a single sample', () => {
  const result = computeRobustEstimate([{ rtt: 20, offset: 3 }]);
  assert.equal(result.status, 'synced');
  assert.equal(result.offsetMs, 3);
  assert.equal(result.rttMs, 20);
});

test('takes the median of the low-RTT half, not the mean, and not all samples', () => {
  // 4 samples -> keepCount = max(3, ceil(4/2)) = 3 lowest-RTT samples kept.
  const samples = [
    { rtt: 10, offset: 100 },
    { rtt: 11, offset: 102 },
    { rtt: 12, offset: 999 }, // kept (3rd-lowest RTT) despite its own offset being unusual
    { rtt: 50, offset: 5 },   // dropped - highest RTT
  ];
  const result = computeRobustEstimate(samples);
  // kept offsets sorted: [100, 102, 999] -> median = 102
  assert.equal(result.offsetMs, 102);
  assert.equal(result.sampleCount, 4);
});

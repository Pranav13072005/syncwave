// Tests for Phase 6.2B's localStorage-backed calibration persistence. Under
// Node (no `localStorage` global, same environment every other client test
// runs in), the try/catch fallback path is what's actually exercised here -
// which is exactly the "fail gracefully when storage is unavailable"
// requirement (privacy mode, disabled storage, etc. behave the same way).
// `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCalibrationOffsetMs, saveCalibrationOffsetMs } from '../src/calibration.js';

test('loadCalibrationOffsetMs defaults to 0 without throwing when localStorage is unavailable', () => {
  assert.equal(typeof localStorage, 'undefined', 'sanity check: this Node test environment has no localStorage global');
  assert.equal(loadCalibrationOffsetMs(), 0);
});

test('saveCalibrationOffsetMs does not throw when localStorage is unavailable', () => {
  assert.doesNotThrow(() => saveCalibrationOffsetMs(25));
});

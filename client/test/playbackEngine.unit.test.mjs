// Pure-function tests for the Phase 4 client-side scheduling math and
// staleness guard. No AudioContext/socket needed. `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAudioContextStartTime, isNewerPlaybackVersion, computeActualPosition } from '../src/playbackEngine.js';

test('computeAudioContextStartTime converts a future server time into a future AudioContext delay', () => {
  // Server is 1500ms ahead of the client's clock (offsetMs=1500), server
  // wants playback to start at serverTime=10000 -> clientTime=8500.
  // "now" is clientTime=7500, so the client should schedule 1s from now.
  const when = computeAudioContextStartTime({
    anchorServerTime: 10000,
    offsetMs: 1500,
    nowMs: 7500,
    audioContextCurrentTime: 100, // arbitrary AudioContext epoch
  });
  assert.ok(Math.abs(when - 101) < 0.001, `expected ~101 (100 + 1s delay), got ${when}`);
});

test('computeAudioContextStartTime treats a missing offset as zero (best-effort fallback)', () => {
  const when = computeAudioContextStartTime({
    anchorServerTime: 5000,
    offsetMs: null,
    nowMs: 4000,
    audioContextCurrentTime: 50,
  });
  assert.ok(Math.abs(when - 51) < 0.001, `expected ~51 (50 + 1s delay), got ${when}`);
});

test('computeAudioContextStartTime handles a target time already in the past (negative delay)', () => {
  const when = computeAudioContextStartTime({
    anchorServerTime: 1000,
    offsetMs: 0,
    nowMs: 3000, // "now" is after the target - e.g. a late-processed event
    audioContextCurrentTime: 20,
  });
  assert.ok(when < 20, 'a past target should produce a time before "now" in AudioContext terms');
  // Callers are expected to clamp this against ctx.currentTime themselves,
  // which schedulePlay/schedulePause both do via Math.max().
});

test('isNewerPlaybackVersion accepts strictly increasing versions and rejects stale/duplicate ones', () => {
  assert.equal(isNewerPlaybackVersion(2, 1), true);
  assert.equal(isNewerPlaybackVersion(1, 1), false); // duplicate/replay
  assert.equal(isNewerPlaybackVersion(1, 2), false); // stale/out-of-order
  assert.equal(isNewerPlaybackVersion(0, -1), true); // first-ever update after init
});

test('computeActualPosition returns null when nothing is scheduled/playing', () => {
  assert.equal(computeActualPosition(null, 42), null);
});

test('computeActualPosition advances with elapsed AudioContext time past the anchor', () => {
  const anchor = { audioContextTime: 10, bufferOffsetSec: 5 };
  const pos = computeActualPosition(anchor, 12.5); // 2.5s of AudioContext time elapsed
  assert.ok(Math.abs(pos - 7.5) < 0.001, `expected ~7.5, got ${pos}`);
});

test('computeActualPosition clamps to the anchor offset during the pre-roll window (not yet started)', () => {
  const anchor = { audioContextTime: 10, bufferOffsetSec: 5 };
  const pos = computeActualPosition(anchor, 8); // ctx.currentTime is before the scheduled start
  assert.equal(pos, 5);
});

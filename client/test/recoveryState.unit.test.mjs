// Tests for the Phase 6 prerequisite-driven recovery state machine. No
// React/socket/timer/AudioContext needed. `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arePrerequisitesMet,
  createInitialRecoveryState,
  receivePlaybackState,
  tryConsumePending,
  computeScheduledPlayingState,
  RECOVERY_SCHEDULING_LEAD_MS,
} from '../src/recoveryState.js';

const ALL_MET = { roomJoined: true, hasLatestState: true, trackDecoded: true, clockSynced: true };
const playback = (version, overrides = {}) => ({ status: 'playing', positionSec: 10, anchorServerTime: 1000, version, trackVersion: 1, ...overrides });

// --- arePrerequisitesMet: every combination of one missing prerequisite ---

test('arePrerequisitesMet is true only when all four prerequisites hold', () => {
  assert.equal(arePrerequisitesMet(ALL_MET), true);
});

test('arePrerequisitesMet is false when the room has not been (re)joined', () => {
  assert.equal(arePrerequisitesMet({ ...ALL_MET, roomJoined: false }), false);
});

test('arePrerequisitesMet is false when the latest state has not arrived yet', () => {
  assert.equal(arePrerequisitesMet({ ...ALL_MET, hasLatestState: false }), false);
});

test('arePrerequisitesMet is false when the track has not been decoded', () => {
  assert.equal(arePrerequisitesMet({ ...ALL_MET, trackDecoded: false }), false);
});

test('arePrerequisitesMet is false when the clock has not been synchronized (no 0ms fallback allowed)', () => {
  assert.equal(arePrerequisitesMet({ ...ALL_MET, clockSynced: false }), false);
});

// --- computeScheduledPlayingState: the position-recalculation fix itself ---

test('calculated late-join start position: positionSec + elapsed time since the anchor, using the canonical formula', () => {
  // Play was issued with positionSec=10 anchored at server time 100000.
  // This device becomes ready at estimated server time 105000 (5s later).
  const result = computeScheduledPlayingState(playback(1, { positionSec: 10, anchorServerTime: 100000 }), 105000 - RECOVERY_SCHEDULING_LEAD_MS);
  // targetServerTime = max(anchorServerTime, nowServerTimeMs + lead) = max(100000, 105000) = 105000
  assert.equal(result.anchorServerTime, 105000);
  assert.ok(Math.abs(result.positionSec - 15) < 0.001, `expected ~15 (10 + 5s elapsed), got ${result.positionSec}`);
});

test('computeScheduledPlayingState never schedules earlier than the state\'s own anchorServerTime (prompt clients unaffected)', () => {
  // A client that receives the command promptly - "now" is well before the
  // command's own future anchor (the normal 1000ms room-wide lead case).
  const result = computeScheduledPlayingState(playback(1, { positionSec: 0, anchorServerTime: 100000 }), 99500);
  assert.equal(result.anchorServerTime, 100000, 'must not pull the schedule earlier than the authoritative anchor');
  assert.equal(result.positionSec, 0, 'position must pass through unchanged when applied promptly');
});

test('computeScheduledPlayingState clamps the computed position to the known track duration', () => {
  const result = computeScheduledPlayingState(
    playback(1, { positionSec: 0, anchorServerTime: 0 }),
    9999 * 1000, // an absurdly late "now" - far past the end of any real track
    { durationSec: 30 },
  );
  assert.equal(result.positionSec, 30, 'must clamp to durationSec rather than propose a position past the end of the track');
});

test('computeScheduledPlayingState leaves the position uncapped when durationSec is not yet known', () => {
  const result = computeScheduledPlayingState(playback(1, { positionSec: 0, anchorServerTime: 0 }), 50000);
  assert.ok(result.positionSec > 40, 'without a known duration there is nothing to clamp against');
});

// --- only-latest-pending-state application ---

test('receiving multiple states before consuming keeps only the newest one pending', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(1));
  state = receivePlaybackState(state, playback(2));
  state = receivePlaybackState(state, playback(3));
  assert.equal(state.pendingPlaybackState.version, 3, 'only the last-received state should be pending, not a queue of all three');
});

test('a pending state is never applied while prerequisites are unmet, regardless of how many arrive', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(1));
  const notReady = { ...ALL_MET, clockSynced: false };
  const result1 = tryConsumePending(state, notReady);
  assert.equal(result1.toApply, null);
  state = receivePlaybackState(result1.nextState, playback(2));
  const result2 = tryConsumePending(state, notReady);
  assert.equal(result2.toApply, null);
  assert.equal(result2.nextState.pendingPlaybackState.version, 2, 'still pending, still only the latest');
});

// --- no schedulePlay() before all prerequisites (this is what toApply===null guarantees) ---

test('no schedulePlay() before all prerequisites: toApply stays null for every prerequisite subset short of all four', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(5, { status: 'playing', positionSec: 20, anchorServerTime: 1000 }));

  const combinations = [
    { roomJoined: false, hasLatestState: true, trackDecoded: true, clockSynced: true },
    { roomJoined: true, hasLatestState: false, trackDecoded: true, clockSynced: true },
    { roomJoined: true, hasLatestState: true, trackDecoded: false, clockSynced: true },
    { roomJoined: true, hasLatestState: true, trackDecoded: true, clockSynced: false },
    { roomJoined: false, hasLatestState: false, trackDecoded: false, clockSynced: false },
  ];
  for (const prereqs of combinations) {
    const result = tryConsumePending(state, prereqs, { nowServerTimeMs: 50000 });
    assert.equal(result.toApply, null, `must not produce a scheduling instruction for ${JSON.stringify(prereqs)}`);
    state = result.nextState; // still pending - never consumed
  }
  assert.equal(state.pendingPlaybackState.version, 5, 'the state must still be sitting there pending, untouched');
});

// --- prerequisite ordering: readiness achieved one prerequisite at a time ---

test('prerequisite ordering: nothing is applied until the LAST missing prerequisite is finally met', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(5, { status: 'paused' })); // paused - avoids needing a nowServerTimeMs for this ordering-focused test

  const step1 = tryConsumePending(state, { roomJoined: true, hasLatestState: true, trackDecoded: false, clockSynced: false });
  assert.equal(step1.toApply, null);
  state = step1.nextState;

  const step2 = tryConsumePending(state, { roomJoined: true, hasLatestState: true, trackDecoded: true, clockSynced: false });
  assert.equal(step2.toApply, null, 'still missing clockSynced');
  state = step2.nextState;

  const step3 = tryConsumePending(state, { roomJoined: true, hasLatestState: true, trackDecoded: true, clockSynced: true });
  assert.equal(step3.toApply?.version, 5, 'applied only once every prerequisite is finally satisfied');
});

// --- late join while playing ---

test('late join while playing: applies at the CURRENT elapsed position, not the stale snapshot from when play was issued', () => {
  let state = createInitialRecoveryState();
  // Room already playing when this device joins - the join ack itself
  // carries the current playback state as it was the moment play started.
  state = receivePlaybackState(state, playback(7, { status: 'playing', positionSec: 42.5, anchorServerTime: 100000 }));
  // This device only finishes its recovery prerequisites 3 seconds later.
  const result = tryConsumePending(state, ALL_MET, { nowServerTimeMs: 103000 - RECOVERY_SCHEDULING_LEAD_MS });
  assert.equal(result.toApply.status, 'playing');
  assert.ok(Math.abs(result.toApply.positionSec - 45.5) < 0.001, `expected ~45.5 (42.5 + 3s elapsed), got ${result.toApply.positionSec}`);
  assert.equal(result.nextState.appliedVersion, 7);
});

test('late join while the room has been playing for a SIGNIFICANT elapsed period (minutes, not seconds)', () => {
  let state = createInitialRecoveryState();
  const anchorServerTime = 1_000_000;
  state = receivePlaybackState(state, playback(2, { status: 'playing', positionSec: 5, anchorServerTime }));
  // 4 minutes pass before this device's prerequisites are all satisfied.
  const fourMinutesLaterMs = anchorServerTime + 4 * 60 * 1000;
  const result = tryConsumePending(state, ALL_MET, { nowServerTimeMs: fourMinutesLaterMs - RECOVERY_SCHEDULING_LEAD_MS, durationSec: 600 });
  assert.ok(Math.abs(result.toApply.positionSec - 245) < 0.001, `expected ~245 (5 + 240s elapsed), got ${result.toApply.positionSec}`);
});

test('no playback from track position 0 during late join, even though the original play command started at position 0', () => {
  let state = createInitialRecoveryState();
  // Host played from the very beginning of the track.
  state = receivePlaybackState(state, playback(1, { status: 'playing', positionSec: 0, anchorServerTime: 50000 }));
  // A device joins 90 seconds into that playback.
  const result = tryConsumePending(state, ALL_MET, { nowServerTimeMs: 140000 - RECOVERY_SCHEDULING_LEAD_MS });
  assert.notEqual(result.toApply.positionSec, 0, 'a late joiner must not start from 0 just because the ORIGINAL command did');
  assert.ok(Math.abs(result.toApply.positionSec - 90) < 0.001, `expected ~90, got ${result.toApply.positionSec}`);
});

// --- late join while paused ---

test('late join while paused: the received "paused" state is surfaced for adoption (caller must not start audio for it)', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(3, { status: 'paused', positionSec: 12, anchorServerTime: null }));
  const result = tryConsumePending(state, ALL_MET);
  assert.equal(result.toApply.status, 'paused');
  assert.equal(result.toApply.positionSec, 12);
  // The module only surfaces the state; whether audio starts is entirely
  // the caller's branch on `toApply.status` (Room.jsx never calls
  // schedulePlay for a 'paused' toApply - covered by Room.jsx's own logic,
  // already reusing the Phase 4 status branch unchanged). A paused state
  // never goes through computeScheduledPlayingState, so no nowServerTimeMs
  // is even needed here - the frozen position needs no extrapolation.
});

// --- reconnect while playing ---

test('reconnect while playing: prerequisites reset to unmet, then re-earned, then the latest (elapsed-adjusted) state applies', () => {
  let state = createInitialRecoveryState();
  // Before the reconnect, this device had already applied version 4.
  state = receivePlaybackState(state, playback(4, { status: 'paused' }));
  state = tryConsumePending(state, ALL_MET).nextState;
  assert.equal(state.appliedVersion, 4);

  // Connection drops and reconnects with a newer authoritative state
  // (someone resumed playback from position 88 while we were offline).
  state = receivePlaybackState(state, playback(9, { status: 'playing', positionSec: 88, anchorServerTime: 200000 }));
  const midRecovery = tryConsumePending(state, { roomJoined: false, hasLatestState: true, trackDecoded: true, clockSynced: false }, { nowServerTimeMs: 200500 });
  assert.equal(midRecovery.toApply, null, 'must wait for room rejoin + re-sync before applying anything post-reconnect');

  // By the time this device finishes rejoining/re-syncing, another 2s passed.
  const afterRecovery = tryConsumePending(midRecovery.nextState, ALL_MET, { nowServerTimeMs: 202000 - RECOVERY_SCHEDULING_LEAD_MS });
  assert.equal(afterRecovery.toApply.version, 9);
  assert.ok(Math.abs(afterRecovery.toApply.positionSec - 90) < 0.001, `expected ~90 (88 + 2s elapsed), got ${afterRecovery.toApply.positionSec}`);
});

// --- stale/duplicate state discarded without applying ---

test('a pending state that is already stale by the time prerequisites are met is discarded, not applied', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(2, { status: 'paused' }));
  state = tryConsumePending(state, ALL_MET).nextState; // applies version 2, appliedVersion=2

  // A late/duplicate broadcast for the OLD version 2 (or older) arrives.
  state = receivePlaybackState(state, playback(2, { status: 'paused' }));
  const result = tryConsumePending(state, ALL_MET);
  assert.equal(result.toApply, null, 'must not re-apply a version that is not newer than what was already applied');
  assert.equal(result.nextState.pendingPlaybackState, null, 'the stale pending entry should be cleared, not left sitting around');
});

test('tryConsumePending is a no-op when nothing is pending', () => {
  const state = createInitialRecoveryState();
  const result = tryConsumePending(state, ALL_MET);
  assert.equal(result.toApply, null);
  assert.equal(result.nextState, state);
});

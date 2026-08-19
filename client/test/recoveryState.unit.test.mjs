// Tests for the Phase 6 prerequisite-driven recovery state machine. No
// React/socket/timer/AudioContext needed. `node --test test/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arePrerequisitesMet,
  createInitialRecoveryState,
  receivePlaybackState,
  tryConsumePending,
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

// --- prerequisite ordering: readiness achieved one prerequisite at a time ---

test('prerequisite ordering: nothing is applied until the LAST missing prerequisite is finally met', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(5));

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

test('late join while playing: the received "playing" state is applied once ready, scheduling into the existing timeline', () => {
  let state = createInitialRecoveryState();
  // Room already playing when this device joins - the join ack itself
  // carries the current playback state.
  state = receivePlaybackState(state, playback(7, { status: 'playing', positionSec: 42.5, anchorServerTime: 5000 }));
  const result = tryConsumePending(state, ALL_MET);
  assert.equal(result.toApply.status, 'playing');
  assert.equal(result.toApply.positionSec, 42.5);
  assert.equal(result.nextState.appliedVersion, 7);
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
  // already reusing the Phase 4 status branch unchanged).
});

// --- reconnect while playing ---

test('reconnect while playing: prerequisites reset to unmet, then re-earned, then the latest state applies', () => {
  let state = createInitialRecoveryState();
  // Before the reconnect, this device had already applied version 4.
  state = receivePlaybackState(state, playback(4));
  state = tryConsumePending(state, ALL_MET).nextState;
  assert.equal(state.appliedVersion, 4);

  // Connection drops and reconnects with a newer authoritative state
  // (someone paused while we were offline, then resumed playback again).
  state = receivePlaybackState(state, playback(9, { status: 'playing', positionSec: 88 }));
  const midRecovery = tryConsumePending(state, { roomJoined: false, hasLatestState: true, trackDecoded: true, clockSynced: false });
  assert.equal(midRecovery.toApply, null, 'must wait for room rejoin + re-sync before applying anything post-reconnect');

  const afterRecovery = tryConsumePending(midRecovery.nextState, ALL_MET);
  assert.equal(afterRecovery.toApply.version, 9);
  assert.equal(afterRecovery.toApply.positionSec, 88);
});

// --- stale/duplicate state discarded without applying ---

test('a pending state that is already stale by the time prerequisites are met is discarded, not applied', () => {
  let state = createInitialRecoveryState();
  state = receivePlaybackState(state, playback(2));
  state = tryConsumePending(state, ALL_MET).nextState; // applies version 2, appliedVersion=2

  // A late/duplicate broadcast for the OLD version 2 (or older) arrives.
  state = receivePlaybackState(state, playback(2));
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

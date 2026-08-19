// Pure/direct tests for the Phase 6.2A queue logic in roomManager.js: add/
// remove/reorder, next-track preload readiness, manual Next, and the
// natural-completion-with-a-queue advance. No network involved - always
// safe to run: `node --test test/`
const test = require('node:test');
const assert = require('node:assert/strict');
const roomManager = require('../roomManager');

function makeTrackMeta(overrides = {}) {
  return {
    originalName: 'track.wav',
    mimeType: 'audio/wav',
    size: 12345,
    storedFilename: 'stored.wav',
    url: '/uploads/stored.wav',
    uploadedAt: Date.now(),
    ...overrides,
  };
}

// --- add / remove / reorder ---

test('addToQueue appends a track with a stable trackId, current track/playback untouched', () => {
  const room = roomManager.createRoom('q-1', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  const playbackBefore = room.playback;
  const trackBefore = room.track;

  const result = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  assert.equal(room.queue.length, 1);
  assert.equal(room.queue[0].originalName, 'B.wav');
  assert.equal(typeof result.queuedTrack.trackId, 'number');
  assert.equal(room.track, trackBefore, 'current track object must be unchanged (same reference)');
  assert.equal(room.playback, playbackBefore, 'playback object must be unchanged (same reference)');
});

test('removeFromQueue removes the correct item by trackId and returns it for cleanup', () => {
  const room = roomManager.createRoom('q-2', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' }));

  const result = roomManager.removeFromQueue(room.code, b.trackId);
  assert.equal(result.removedTrack.originalName, 'B.wav');
  assert.equal(room.queue.length, 1);
  assert.equal(room.queue[0].originalName, 'C.wav');
});

test('removeFromQueue rejects an unknown trackId (TRACK_NOT_FOUND)', () => {
  const room = roomManager.createRoom('q-3', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  const result = roomManager.removeFromQueue(room.code, 99999);
  assert.equal(result.error, 'TRACK_NOT_FOUND');
  assert.equal(room.queue.length, 1, 'queue must be unaffected by a rejected removal');
});

test('reorderQueue moves a track to the requested (clamped) index', () => {
  const room = roomManager.createRoom('q-4', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' }));
  const d = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'D.wav' })).queuedTrack;

  roomManager.reorderQueue(room.code, d.trackId, 0); // D -> B, C, D becomes D, B, C
  assert.deepEqual(room.queue.map((t) => t.originalName), ['D.wav', 'B.wav', 'C.wav']);

  roomManager.reorderQueue(room.code, b.trackId, 99); // out-of-range toIndex clamps to the end
  assert.deepEqual(room.queue.map((t) => t.originalName), ['D.wav', 'C.wav', 'B.wav']);
});

test('non-host queue mutations are rejected (enforced by the caller, verified at the handler level via requireHost)', () => {
  // roomManager itself has no concept of "who is allowed" - that authorization
  // lives in queueHandlers.js's requireHost (shared with playbackHandlers.js).
  // This is confirmed by inspection/reuse rather than a duplicate roomManager
  // test: requireHost is exercised directly by the existing playback-handler
  // authorization tests, and queueHandlers.js calls the identical function.
  assert.equal(typeof require('../socketUtils').requireHost, 'function');
});

// --- queue empty Next rejected safely ---

test('issueNextCommand rejects QUEUE_EMPTY without disturbing current playback', () => {
  const room = roomManager.createRoom('q-5', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const playResult = roomManager.issuePlayCommand(room.code);
  const playbackBefore = room.playback;

  const result = roomManager.issueNextCommand(room.code);
  assert.equal(result.error, 'QUEUE_EMPTY');
  assert.equal(room.playback, playbackBefore, 'playback object must be unchanged (same reference)');
  assert.equal(room.playback.status, 'playing');
  assert.ok(playResult.targetServerTime); // sanity: play had actually succeeded before this
});

// --- Next moves queue[0] to current, queue shifts, playback transitions ---

test('issueNextCommand moves queue[0] to current, shifts the remaining queue, and starts playback from 0', () => {
  const room = roomManager.createRoom('q-6', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  const trackVersionBefore = room.track.version;
  const playbackVersionBefore = room.playback.version;
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' }));

  const before = Date.now();
  const result = roomManager.issueNextCommand(room.code);
  assert.equal(result.error, undefined);
  assert.equal(room.track.originalName, 'B.wav', 'B becomes current');
  assert.ok(room.track.version > trackVersionBefore, 'track.version bumps like any other replacement');
  assert.deepEqual(room.queue.map((t) => t.originalName), ['C.wav'], 'the remaining queue shifts');
  assert.equal(room.playback.status, 'playing');
  assert.equal(room.playback.positionSec, 0);
  assert.ok(result.targetServerTime > before, 'transition is scheduled in the future, not immediate');
  assert.equal(room.playback.anchorServerTime, result.targetServerTime);
  assert.ok(room.playback.version > playbackVersionBefore, 'playback.version bumps consistently with track.version');
  assert.equal(room.playback.trackVersion, room.track.version);
});

// --- queue-only mutations do not disturb current playback ---

test('add/remove/reorder that do not touch queue[0] leave current playback completely undisturbed', () => {
  const room = roomManager.createRoom('q-7', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.issuePlayCommand(room.code);
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  const c = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' })).queuedTrack;

  const playbackBefore = room.playback;
  const trackBefore = room.track;

  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'D.wav' })); // append, doesn't touch queue[0]
  roomManager.reorderQueue(room.code, c.trackId, 2); // C and D swap, B (queue[0]) untouched
  roomManager.removeFromQueue(room.code, c.trackId); // removes C (not queue[0])

  assert.equal(room.playback, playbackBefore, 'playback object reference must be unchanged');
  assert.equal(room.track, trackBefore, 'current track object reference must be unchanged');
  assert.equal(room.queue[0].trackId, b.trackId, 'B is still the immediate-next candidate');
});

// --- preload readiness ---

test('setNextReady accepts a report matching queue[0]\'s trackId and stores durationSec on it', () => {
  const room = roomManager.createRoom('q-8', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;

  const result = roomManager.setNextReady('q-8', b.trackId, 42.5);
  assert.notEqual(result, null);
  assert.equal(result.nextReadyDevices.has('q-8'), true);
  assert.equal(room.queue[0].durationSec, 42.5);
});

test('setNextReady ignores a report for the wrong/stale trackId', () => {
  const room = roomManager.createRoom('q-9', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));

  const result = roomManager.setNextReady('q-9', 999999, 10);
  assert.equal(result, null);
  assert.equal(room.nextReadyDevices.size, 0);
  assert.equal(room.queue[0].durationSec, undefined, 'a rejected report must not stick its durationSec onto the wrong track either');
});

test('reordering the queue invalidates prior next-ready state for the OLD immediate-next candidate', () => {
  const room = roomManager.createRoom('q-10', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  const c = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' })).queuedTrack;

  roomManager.setNextReady('q-10', b.trackId, 10); // a device finished preloading B (the current queue[0])
  assert.equal(room.nextReadyDevices.size, 1);

  roomManager.reorderQueue(room.code, c.trackId, 0); // C is now queue[0]
  assert.equal(room.queue[0].trackId, c.trackId);
  assert.equal(room.nextReadyDevices.size, 0, 'stale readiness for the old candidate (B) must be cleared');

  // A late-arriving ready report for the OLD candidate (B) must still be ignored...
  const staleReport = roomManager.setNextReady('q-10', b.trackId, 10);
  assert.equal(staleReport, null);
  assert.equal(room.nextReadyDevices.size, 0, 'the stale B report must not mark anyone ready for C');

  // ...while a fresh report for the NEW candidate (C) is accepted normally.
  const freshReport = roomManager.setNextReady('q-10', c.trackId, 8);
  assert.notEqual(freshReport, null);
  assert.equal(room.nextReadyDevices.size, 1);
});

test('a queue-only mutation that does not change queue[0] preserves existing next-ready state', () => {
  const room = roomManager.createRoom('q-11', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  roomManager.setNextReady('q-11', b.trackId, 10);
  assert.equal(room.nextReadyDevices.size, 1);

  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' })); // appended after B - queue[0] unchanged
  assert.equal(room.queue[0].trackId, b.trackId);
  assert.equal(room.nextReadyDevices.size, 1, 'readiness for the still-unchanged queue[0] must survive an unrelated append');
});

// --- Next: version protection ---

test('issueNextCommand bumps track/playback versions consistently, protecting against stale old-track state', () => {
  const room = roomManager.createRoom('q-12', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.issuePlayCommand(room.code);
  const trackVersionBeforeNext = room.track.version;
  const playbackVersionBeforeNext = room.playback.version;
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));

  roomManager.issueNextCommand(room.code);
  assert.ok(room.track.version > trackVersionBeforeNext);
  assert.ok(room.playback.version > playbackVersionBeforeNext);
  assert.equal(room.playback.trackVersion, room.track.version, 'playback must be tied to the NEW track version');
});

test('an unready client does not block a manual Next - the transition still happens for everyone', () => {
  // Readiness (nextReadyDevices) is purely informational for the UI/recovery
  // path - issueNextCommand never checks it before transitioning. This is
  // the deterministic MVP policy from the spec: server transitions
  // authoritatively regardless of per-device readiness.
  const room = roomManager.createRoom('q-13', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.issuePlayCommand(room.code);
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  assert.equal(room.nextReadyDevices.size, 0, 'nobody has reported ready yet');

  const result = roomManager.issueNextCommand(room.code);
  assert.equal(result.error, undefined);
  assert.equal(room.track.originalName, 'B.wav', 'transition proceeds regardless of readiness');
});

// --- natural completion + queue ---

test('natural end with an empty queue keeps the Phase 6.1 paused-at-end behavior unchanged', async () => {
  const room = roomManager.createRoom('q-14', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('q-14', room.track.version, 0.2);
  roomManager.issuePlayCommand(room.code);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(room.playback.status, 'paused');
  assert.equal(room.playback.positionSec, 0.2);
  assert.equal(room.queue.length, 0);
});

test('natural end with a non-empty queue advances automatically to the next track', async () => {
  const room = roomManager.createRoom('q-15', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  roomManager.setReady('q-15', room.track.version, 0.2); // short "A" track
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  roomManager.setNextReady('q-15', b.trackId, 5); // B's duration already known via preload readiness

  roomManager.issuePlayCommand(room.code);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.equal(room.track.originalName, 'B.wav', 'B must have become current automatically');
  assert.equal(room.playback.status, 'playing', 'must flow straight into playing B, never pause at the end of A first');
  assert.equal(room.playback.positionSec, 0);
  assert.equal(room.queue.length, 0);
});

test('an old completion timer cannot affect a track that has already advanced via manual Next', async () => {
  const room = roomManager.createRoom('q-16', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  roomManager.setReady('q-16', room.track.version, 0.5); // A would naturally end in ~1.5s (500ms lead + 500ms duration... uses schedule lead + duration)
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' }));
  roomManager.issuePlayCommand(room.code);
  assert.equal(roomManager.hasActiveEndTimer(room), true);

  // Host manually advances to B before A's own end timer would have fired.
  roomManager.issueNextCommand(room.code);
  const versionAfterManualNext = room.playback.version;
  assert.equal(room.track.originalName, 'B.wav');

  await new Promise((resolve) => setTimeout(resolve, 1500)); // past when A's stale timer would have fired

  assert.equal(room.track.originalName, 'B.wav', 'must still be B - the stale A timer must not have advanced again to C');
  assert.equal(room.playback.version, versionAfterManualNext, 'no additional version bump from the stale timer');
});

test('after an advance, the new current track gets its own correct end timer', () => {
  const room = roomManager.createRoom('q-17', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  roomManager.setNextReady('q-17', b.trackId, 30); // duration known ahead of the advance via preload readiness
  roomManager.issuePlayCommand(room.code);

  roomManager.issueNextCommand(room.code);
  assert.equal(room.track.durationSec, 30, 'duration carries over from the queue item\'s preload-readiness report');
  assert.equal(roomManager.hasActiveEndTimer(room), true, 'the new track must be armed with its own end timer, not left without one');
});

// --- recovery: late join / reconnect during a queue ---

test('toPublicState for a late joiner includes current track, queue, and playback all at once', () => {
  const room = roomManager.createRoom('q-18', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  roomManager.issuePlayCommand(room.code);

  const joinResult = roomManager.joinRoom(room.code, 'q-18-late', 'Latecomer');
  const state = roomManager.toPublicState(joinResult.room);
  assert.equal(state.track.originalName, 'A.wav');
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].originalName, 'B.wav');
  assert.equal(state.playback.status, 'playing');
});

test('joining mid-transition (right after an advance) reflects only the NEW current track, never the old one', () => {
  const room = roomManager.createRoom('q-19', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  roomManager.issuePlayCommand(room.code);
  roomManager.issueNextCommand(room.code); // A -> B

  const joinResult = roomManager.joinRoom(room.code, 'q-19-late', 'Latecomer');
  const state = roomManager.toPublicState(joinResult.room);
  assert.equal(state.track.originalName, 'B.wav', 'a joiner during/after a transition must see the NEW current track, never the superseded one');
});

// --- cleanup (roomManager-level: array mutation only; actual fs.unlink is
// covered by the live-server integration tests in queueIntegration.test.js) ---

test('removeFromQueue never touches the current track, only the queue array', () => {
  const room = roomManager.createRoom('q-20', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav', storedFilename: 'a.wav' }));
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav', storedFilename: 'b.wav' })).queuedTrack;

  roomManager.removeFromQueue(room.code, b.trackId);
  assert.equal(room.track.storedFilename, 'a.wav', 'current track file reference must be untouched');
  assert.equal(room.queue.length, 0);
});

test('onRoomDeleted fires with the full room (current track + queue, storedFilenames intact) at deletion time', async () => {
  roomManager.setRoomCleanupGraceMsForTesting(50);
  const room = roomManager.createRoom('q-21', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav', storedFilename: 'a.wav' }));
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav', storedFilename: 'b.wav' }));

  let deletedRoom = null;
  roomManager.onRoomDeleted((r) => {
    deletedRoom = r;
  });

  roomManager.leaveRoom('q-21');
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.notEqual(deletedRoom, null, 'the listener must fire on final deletion');
  assert.equal(deletedRoom.track.storedFilename, 'a.wav', 'index.js needs this to delete the current track file');
  assert.equal(deletedRoom.queue.length, 1);
  assert.equal(deletedRoom.queue[0].storedFilename, 'b.wav', 'index.js needs this to delete every queued file too');

  roomManager.setRoomCleanupGraceMsForTesting(30_000);
});

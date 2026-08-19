// Phase 6.2A.1 reliability-fix regression tests: multi-device join behavior
// and stale-track/stale-state protection across a chain of transitions.
// `node --test test/` (the live-server tests require the dev server running,
// same convention as every other *.integration-style test in this project).
const test = require('node:test');
const assert = require('node:assert/strict');
const roomManager = require('../roomManager');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');
const { BASE, waitConnected, emitAck, uploadTrack } = require('../testUtils');

const wavPath = path.join(__dirname, '..', 'public', 'audio', 'test-tone.wav');
const wavBytes = fs.readFileSync(wavPath);

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

// --- membership changes must never look like a playback/track change ---

test('joinRoom during active playback never touches playback or track state', () => {
  const room = roomManager.createRoom('rel-1', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const playResult = roomManager.issuePlayCommand(room.code);
  const playbackBefore = room.playback;
  const trackBefore = room.track;

  roomManager.joinRoom(room.code, 'rel-1-guest-a', 'GuestA');
  roomManager.joinRoom(room.code, 'rel-1-guest-b', 'GuestB');
  roomManager.joinRoom(room.code, 'rel-1-guest-c', 'GuestC');

  assert.equal(room.playback, playbackBefore, 'playback object reference must be unchanged by any join');
  assert.equal(room.track, trackBefore, 'track object reference must be unchanged by any join');
  assert.equal(room.playback.version, playbackBefore.version);
  assert.ok(playResult.targetServerTime); // sanity
});

test('leaveRoom (a participant, not the host) during active playback never touches playback or track state', () => {
  const room = roomManager.createRoom('rel-2', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.joinRoom(room.code, 'rel-2-guest', 'Guest');
  roomManager.issuePlayCommand(room.code);
  const playbackBefore = room.playback;

  roomManager.leaveRoom('rel-2-guest');

  assert.equal(room.playback, playbackBefore, 'a participant leaving must not disturb playback state');
});

// --- multiple near-simultaneous late joiners recover independently ---

test('several devices joining an already-playing room close together each get correct, consistent state, and the host sees no playback.version churn from the joins', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(tokenRes.token, wavBytes);
  await emitAck(host, 'playback:play', {});

  const versionsSeenByHost = [];
  host.on('room:update', (state) => versionsSeenByHost.push(state.playback.version));

  const joiners = [io(BASE), io(BASE), io(BASE)];
  t.after(() => joiners.forEach((s) => s.close()));
  await Promise.all(joiners.map(waitConnected));

  // Join all three within a tight window, deliberately close together.
  const joinAcks = await Promise.all(
    joiners.map((s, i) => emitAck(s, 'room:join', { roomCode, name: `Late${i}` })),
  );

  const playbackVersionAtPlay = joinAcks[0].state.playback.version;
  for (const ack of joinAcks) {
    assert.equal(ack.ok, true);
    assert.equal(ack.state.track.originalName, 'test-tone.wav');
    assert.equal(ack.state.playback.status, 'playing');
    assert.equal(ack.state.playback.version, playbackVersionAtPlay, 'every late joiner must see the SAME authoritative playback version - joins do not bump it');
  }

  const distinctVersionsFromJoinBroadcasts = new Set(versionsSeenByHost);
  assert.deepEqual(
    [...distinctVersionsFromJoinBroadcasts],
    [playbackVersionAtPlay],
    'the host must never observe a playback.version change purely from other devices joining',
  );
});

// --- A -> B -> C: a stale intermediate advance cannot corrupt the latest one ---

test('advancing A -> B -> C in quick succession: B\'s end timer and stale next-ready state cannot leak into C', async () => {
  const room = roomManager.createRoom('rel-4', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  roomManager.setReady('rel-4', room.track.version, 100); // long A, so its own timer isn't the one that matters here
  const b = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' })).queuedTrack;
  const c = roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' })).queuedTrack;
  roomManager.issuePlayCommand(room.code);

  // Advance to B, then immediately report B as "next ready" for some device,
  // then advance AGAIN to C before that report could matter.
  roomManager.issueNextCommand(room.code); // A -> B
  assert.equal(room.track.originalName, 'B.wav');
  const bVersionAfterAdvance = room.track.version;
  const playbackVersionAfterFirstAdvance = room.playback.version;

  roomManager.issueNextCommand(room.code); // B -> C
  assert.equal(room.track.originalName, 'C.wav');
  assert.ok(room.track.version > bVersionAfterAdvance);
  assert.ok(room.playback.version > playbackVersionAfterFirstAdvance);
  assert.equal(room.queue.length, 0);

  // A stale next-ready report for B (now long gone, C is current with an
  // empty queue) must be rejected - queue[0] doesn't exist anymore.
  const staleReport = roomManager.setNextReady('rel-4', b.trackId, 10);
  assert.equal(staleReport, null, 'B is no longer queue[0] (or even in the queue) - a stale report for it must be ignored');
  assert.equal(room.nextReadyDevices.size, 0);

  // Give any of A's/B's now-superseded timers a chance to have fired if they
  // incorrectly weren't cancelled - C must still be untouched.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(room.track.originalName, 'C.wav', 'a stale timer from A or B must not have altered the current track');
});

test('an unready client\'s stale local playback state cannot survive a second advance (server-side identity check)', () => {
  // Mirrors the client-side "retire stale source" fix: at the SERVER layer,
  // this is just confirming playback.trackVersion always reflects the
  // LATEST track after any number of chained advances, which is what the
  // client's getCurrentTrackVersion()-vs-playback.trackVersion comparison
  // (playbackEngine.js / Room.jsx) relies on to detect staleness.
  const room = roomManager.createRoom('rel-5', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'A.wav' }));
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'B.wav' }));
  roomManager.addToQueue(room.code, makeTrackMeta({ originalName: 'C.wav' }));
  roomManager.issuePlayCommand(room.code);

  roomManager.issueNextCommand(room.code); // -> B
  const trackVersionAfterB = room.playback.trackVersion;
  roomManager.issueNextCommand(room.code); // -> C
  const trackVersionAfterC = room.playback.trackVersion;

  assert.notEqual(trackVersionAfterB, trackVersionAfterC, 'a client still holding trackVersionAfterB must be detectable as stale against the final state');
  assert.equal(room.playback.trackVersion, room.track.version, 'authoritative playback.trackVersion always matches the CURRENT track, never an intermediate one');
});

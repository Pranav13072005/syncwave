// Tests for the server-side natural-completion timer (roomManager.js:
// scheduleEndTimer/cancelEndTimer/completeNaturalPlayback). Uses short real
// track durations (tenths of a second) so the timer actually fires within
// the test's own runtime, rather than needing a test-only override like the
// room-cleanup grace period does - the "remaining time" here is derived data
// (durationSec - positionSec), not a fixed constant, so tests can just make
// it small directly. `node --test test/`
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const roomManager = require('../roomManager');
const { io } = require('socket.io-client');

const BASE = process.env.SYNCWAVE_SERVER_URL || 'http://localhost:3001';
const wavPath = path.join(__dirname, '..', 'public', 'audio', 'test-tone.wav');
const wavBytes = fs.readFileSync(wavPath);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
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

// --- natural completion transitions authoritative state ---

test('natural completion transitions authoritative state to paused at the track duration, with a version bump', async () => {
  const room = roomManager.createRoom('nc-1', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('nc-1', room.track.version, 0.2); // 200ms "track"
  const playResult = roomManager.issuePlayCommand(room.code);
  const versionAfterPlay = playResult.room.playback.version;
  assert.equal(roomManager.hasActiveEndTimer(room), true);

  await sleep(1500); // well past the 1000ms schedule lead + 200ms duration

  assert.equal(room.playback.status, 'paused', 'natural completion must transition to paused');
  assert.equal(room.playback.positionSec, 0.2, 'completed position must equal the track duration exactly');
  assert.ok(room.playback.version > versionAfterPlay, 'playback version must increment on natural completion');
  assert.equal(roomManager.hasActiveEndTimer(room), false, 'the end timer clears itself once fired');
});

// --- stale-timer protection ---

test('an old end timer cannot affect playback after a Pause supersedes it', async () => {
  const room = roomManager.createRoom('nc-2', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('nc-2', room.track.version, 0.2);
  roomManager.issuePlayCommand(room.code);

  await sleep(200); // let some real time pass while still playing
  const pauseResult = roomManager.issuePauseCommand(room.code);
  const pausedPosition = pauseResult.room.playback.positionSec;
  const versionAfterPause = pauseResult.room.playback.version;

  await sleep(1500); // well past when the OLD timer would have fired

  assert.equal(room.playback.status, 'paused');
  assert.equal(room.playback.positionSec, pausedPosition, 'must still reflect the Pause, not get overwritten by the stale completion timer');
  assert.equal(room.playback.version, versionAfterPause, 'version must not have changed again');
});

test('an old end timer cannot affect playback after a Seek supersedes it', async () => {
  const room = roomManager.createRoom('nc-3', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('nc-3', room.track.version, 5); // 5s track, so the original end timer has a long delay
  roomManager.issuePlayCommand(room.code);

  const seekResult = roomManager.issueSeekCommand(room.code, 4.9); // now only 100ms of "remaining" from the NEW anchor
  const versionAfterSeek = seekResult.room.playback.version;

  await sleep(1500); // past the new (short) remaining time, and far short of the ORIGINAL 5s timer

  assert.equal(room.playback.status, 'paused', 'the replacement (seek-based) timer should have fired by now');
  assert.equal(room.playback.positionSec, 5, 'completes at the real duration, from the seek-adjusted timeline');
  assert.ok(room.playback.version > versionAfterSeek, 'the replacement timer, not the stale original one, drove this completion');
});

test('Seek while playing creates the correct replacement end timer (not just cancels the old one)', () => {
  const room = roomManager.createRoom('nc-4', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('nc-4', room.track.version, 100);
  roomManager.issuePlayCommand(room.code);
  assert.equal(roomManager.hasActiveEndTimer(room), true);

  roomManager.issueSeekCommand(room.code, 50);
  assert.equal(roomManager.hasActiveEndTimer(room), true, 'a NEW timer must be scheduled, not left cancelled, since playback is still active');
});

test('a stale timer cannot affect a replacement track (track replacement cancels it)', async () => {
  const room = roomManager.createRoom('nc-5', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('nc-5', room.track.version, 0.2);
  roomManager.issuePlayCommand(room.code);
  assert.equal(roomManager.hasActiveEndTimer(room), true);

  const setTrackResult = roomManager.setTrack(room.code, makeTrackMeta({ originalName: 'new-track.wav', storedFilename: 'new.wav' }));
  assert.equal(roomManager.hasActiveEndTimer(room), false, 'track replacement must cancel the old track\'s end timer');
  const versionAfterReplace = setTrackResult.room.playback.version;

  await sleep(1500); // well past when the OLD track's timer would have fired

  assert.equal(room.track.originalName, 'new-track.wav', 'the new track must still be current');
  assert.equal(room.playback.status, 'paused', 'new track starts paused, untouched by the old timer');
  assert.equal(room.playback.positionSec, 0);
  assert.equal(room.playback.version, versionAfterReplace, 'version must not have been bumped by a stale completion');
});

// --- room deletion clears the end timer ---

test('room deletion clears the end timer (no leak)', async () => {
  roomManager.setRoomCleanupGraceMsForTesting(50);
  const room = roomManager.createRoom('nc-6', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('nc-6', room.track.version, 100); // long track - end timer would fire far in the future
  roomManager.issuePlayCommand(room.code);
  assert.equal(roomManager.hasActiveEndTimer(room), true);

  roomManager.leaveRoom('nc-6'); // empties the room, starts the cleanup grace period
  await sleep(150); // past the 50ms grace period

  assert.equal(roomManager.getRoom(room.code), null, 'room must be deleted');
  assert.equal(roomManager.hasActiveEndTimer(room), false, 'the end timer must be cleared on final deletion, not left dangling');

  roomManager.setRoomCleanupGraceMsForTesting(30_000);
});

// --- integration: completion broadcast to room members ---

function waitConnected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}
function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}
function waitForRoomUpdate(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room:update', handler);
      reject(new Error('waitForRoomUpdate timed out'));
    }, timeoutMs);
    function handler(state) {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off('room:update', handler);
        resolve(state);
      }
    }
    socket.on('room:update', handler);
  });
}
async function uploadTrack(token, bytes, filename = 'test-tone.wav') {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: token ? { 'x-upload-token': token } : {},
    body: form,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('natural completion is broadcast to room members (integration, live server)', async (t) => {
  const host = io(BASE);
  const guest = io(BASE);
  t.after(() => {
    host.close();
    guest.close();
  });

  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;
  await waitConnected(guest);
  await emitAck(guest, 'room:join', { roomCode, name: 'Guest' });

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(tokenRes.token, wavBytes);
  // Report a very short duration so completion happens quickly, without
  // waiting for the real (several-second) test-tone.wav to actually finish.
  await emitAck(host, 'track:ready', { version: 1, durationSec: 0.2 });
  await emitAck(host, 'playback:play', {});

  const guestSeesCompletion = waitForRoomUpdate(guest, (state) => state.playback.status === 'paused' && state.playback.positionSec === 0.2, 4000);
  const completedState = await guestSeesCompletion;
  assert.equal(completedState.playback.status, 'paused');
  assert.equal(completedState.playback.positionSec, 0.2);
});

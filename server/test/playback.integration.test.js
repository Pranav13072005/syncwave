// Integration tests for Phase 4 playback control against a REAL running
// server. Requires the backend already running: `npm start` (default
// http://localhost:3001, override with SYNCWAVE_SERVER_URL). Not
// auto-started for the same reason as the Phase 3 integration tests -
// server/index.js binds its port as a load-time side effect; in-process
// harnessing is Phase 7 scope. Run with: node --test test/ (server running first)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const BASE = process.env.SYNCWAVE_SERVER_URL || 'http://localhost:3001';
const wavPath = path.join(__dirname, '..', 'public', 'audio', 'test-tone.wav');
const wavBytes = fs.readFileSync(wavPath);

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
async function uploadTrack(baseUrl, token, bytes, filename = 'test-tone.wav') {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { 'x-upload-token': token },
    body: form,
  });
  return res.json();
}

test('playback commands are rejected for a non-host client', async (t) => {
  const host = io(BASE);
  const guest = io(BASE);
  t.after(() => {
    host.close();
    guest.close();
  });
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  await waitConnected(guest);
  await emitAck(guest, 'room:join', { roomCode: createRes.state.roomCode, name: 'Guest' });

  const playAck = await emitAck(guest, 'playback:play', {});
  assert.equal(playAck.ok, false);
  assert.equal(playAck.error, 'NOT_HOST');

  const pauseAck = await emitAck(guest, 'playback:pause', {});
  assert.equal(pauseAck.error, 'NOT_HOST');

  const seekAck = await emitAck(guest, 'playback:seek', { positionSec: 5 });
  assert.equal(seekAck.error, 'NOT_HOST');
});

test('playback commands are rejected when the room has no track yet', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  await emitAck(host, 'room:create', { name: 'Host' });

  const playAck = await emitAck(host, 'playback:play', {});
  assert.equal(playAck.ok, false);
  assert.equal(playAck.error, 'NO_TRACK');
});

test('a socket not in any room is rejected with NO_ROOM', async (t) => {
  const lone = io(BASE);
  t.after(() => lone.close());
  await waitConnected(lone);
  const ack = await emitAck(lone, 'playback:play', {});
  assert.equal(ack.error, 'NO_ROOM');
});

test('host play -> pause -> seek flow: version increments and both clients see consistent state', async (t) => {
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

  // Upload a track first (playback requires one).
  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  const uploadResult = await uploadTrack(BASE, tokenRes.token, wavBytes);
  assert.ok(uploadResult.ok, 'upload should succeed');
  const trackVersion = uploadResult.track.version;

  // PLAY: guest should see status flip to 'playing' via room:update.
  const guestSeesPlaying = waitForRoomUpdate(guest, (s) => s.playback?.status === 'playing');
  const playAck = await emitAck(host, 'playback:play', {});
  assert.equal(playAck.ok, true);
  const playingState = await guestSeesPlaying;
  assert.equal(playingState.playback.trackVersion, trackVersion);
  assert.ok(playingState.playback.anchorServerTime > Date.now() - 100, 'anchor should be roughly now-or-future');
  const versionAfterPlay = playingState.playback.version;

  // PAUSE: version must strictly increase again.
  const guestSeesPaused = waitForRoomUpdate(guest, (s) => s.playback?.status === 'paused' && s.playback.version > versionAfterPlay);
  const pauseAck = await emitAck(host, 'playback:pause', {});
  assert.equal(pauseAck.ok, true);
  const pausedState = await guestSeesPaused;
  assert.ok(pausedState.playback.version > versionAfterPlay, 'pause must increment the playback version');
  const versionAfterPause = pausedState.playback.version;

  // SEEK: position updates, status stays paused, version increases again.
  const guestSeesSeek = waitForRoomUpdate(guest, (s) => s.playback?.version > versionAfterPause);
  const seekAck = await emitAck(host, 'playback:seek', { positionSec: 3.25 });
  assert.equal(seekAck.ok, true);
  const seekState = await guestSeesSeek;
  assert.equal(seekState.playback.status, 'paused');
  assert.equal(seekState.playback.positionSec, 3.25);
  assert.ok(seekState.playback.version > versionAfterPause, 'seek must increment the playback version');
});

test('seek is rejected gracefully for an invalid or out-of-range position', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  await emitAck(host, 'room:create', { name: 'Host' });

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(BASE, tokenRes.token, wavBytes);

  const negativeAck = await emitAck(host, 'playback:seek', { positionSec: -1 });
  assert.equal(negativeAck.error, 'INVALID_SEEK_POSITION');

  // Report a known duration, then try to seek past it.
  const readyAck = await emitAck(host, 'track:ready', { version: 1, durationSec: 6 });
  assert.equal(readyAck.ok, true);
  const outOfRangeAck = await emitAck(host, 'playback:seek', { positionSec: 999 });
  assert.equal(outOfRangeAck.error, 'SEEK_OUT_OF_RANGE');
});

// Regression tests for the Phase 6 bugfix round: a participant's socket
// disconnecting must never alter authoritative room playback (no server-side
// pause is ever triggered by a non-host disconnecting - the client-side
// "stop local audio" behavior lives entirely in Room.jsx/playbackEngine.js
// and can only be verified in a real browser, see manual verification
// steps), and a reconnecting client must receive whatever the CURRENT
// authoritative state is, not a stale pre-disconnect snapshot. Requires the
// live server (npm start). `node --test test/`
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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test('no room-wide pause caused by a non-host participant disconnecting while playing', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(tokenRes.token, wavBytes);
  const playAck = await emitAck(host, 'playback:play', {});
  assert.equal(playAck.ok, true);

  const participant = io(BASE);
  await waitConnected(participant);
  await emitAck(participant, 'room:join', { roomCode, name: 'Participant' });

  // Watch for any room:update the host receives after the disconnect and
  // confirm playback is untouched (still 'playing', same version).
  let sawUnexpectedPauseOrVersionBump = false;
  const versionBeforeRef = { version: null };
  const captureVersion = new Promise((resolve) => {
    host.once('room:update', (state) => {
      versionBeforeRef.version = state.playback.version;
      resolve();
    });
  });
  // Trigger one room:update by having the participant report readiness (a
  // harmless, playback-state-neutral event) so we can capture the current
  // playback.version as our baseline before disconnecting.
  await emitAck(participant, 'track:ready', { version: 1, durationSec: 6 });
  await captureVersion;

  const observedAfterDisconnect = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 400);
    host.on('room:update', (state) => {
      if (state.playback.status !== 'playing' || state.playback.version !== versionBeforeRef.version) {
        sawUnexpectedPauseOrVersionBump = true;
      }
      clearTimeout(timer);
      resolve(state);
    });
  });

  participant.close(); // simulate the participant losing connectivity
  await observedAfterDisconnect;

  assert.equal(sawUnexpectedPauseOrVersionBump, false, 'a participant disconnecting must not pause or otherwise change authoritative playback');

  // Directly confirm via a fresh observer that the room is still playing.
  const observer = io(BASE);
  t.after(() => observer.close());
  await waitConnected(observer);
  const observerJoin = await emitAck(observer, 'room:join', { roomCode, name: 'Observer' });
  assert.equal(observerJoin.state.playback.status, 'playing');
});

test('reconnect resumes from the authoritative CURRENT position, not a stale pre-disconnect snapshot', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(tokenRes.token, wavBytes);
  await emitAck(host, 'playback:play', {});

  const participant = io(BASE);
  await waitConnected(participant);
  const firstJoin = await emitAck(participant, 'room:join', { roomCode, name: 'Participant' });
  const versionAtFirstJoin = firstJoin.state.playback.version;

  participant.disconnect();
  await sleep(50); // let the disconnect land server-side

  // While the participant is gone, the host changes the authoritative state
  // (seek to a new position) - this must NOT be visible to the participant
  // until they actually reconnect.
  const seekAck = await emitAck(host, 'playback:seek', { positionSec: 77 });
  assert.equal(seekAck.ok, true);

  const reconnected = io(BASE);
  t.after(() => reconnected.close());
  await waitConnected(reconnected);
  const rejoinAck = await emitAck(reconnected, 'room:join', { roomCode, name: 'Participant' });

  assert.equal(rejoinAck.ok, true);
  assert.ok(rejoinAck.state.playback.version > versionAtFirstJoin, 'rejoin must reflect a newer version than what was seen before disconnecting');
  assert.equal(rejoinAck.state.playback.positionSec, 77, 'rejoin must deliver the CURRENT authoritative position (post-seek), not the stale one from before the disconnect');
});

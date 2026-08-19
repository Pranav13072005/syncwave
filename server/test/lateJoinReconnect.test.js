// Integration tests for the server-side data flow behind Phase 6 late join
// and reconnect: does a (re)joining client's ack correctly deliver the
// room's CURRENT authoritative playback state, unmodified for existing
// members? Requires the live server (npm start). The actual client-side
// Web Audio scheduling triggered by this data can only be verified in a
// real browser (see manual verification steps) - this file verifies the
// server hands over exactly the right data for that scheduling to work from.
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

test('late join while playing: the join ack carries the current playing state, unmodified for the existing member', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(tokenRes.token, wavBytes);
  const playAck = await emitAck(host, 'playback:play', {});
  assert.equal(playAck.ok, true);

  const lateJoiner = io(BASE);
  t.after(() => lateJoiner.close());
  await waitConnected(lateJoiner);

  const noUpdateForHost = new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 300); // host should NOT see its own playback reset/altered
    host.once('room:update', (state) => {
      clearTimeout(timer);
      if (state.playback.status !== 'playing') {
        reject(new Error('late join must not alter existing playback status'));
      } else {
        resolve();
      }
    });
  });

  const joinRes = await emitAck(lateJoiner, 'room:join', { roomCode, name: 'LateJoiner' });
  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.state.playback.status, 'playing', 'late joiner must see the room is currently playing');
  assert.equal(joinRes.state.playback.trackVersion, 1);
  assert.ok(joinRes.state.track != null, 'late joiner must receive the current track metadata to decode');

  await noUpdateForHost; // confirms the existing host's own playback view was not disturbed
});

test('late join while paused: the join ack carries the current paused position, status stays paused', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(tokenRes.token, wavBytes);
  // Track uploaded but never played - room starts paused at position 0 by default.
  assert.equal(createRes.state.roomCode, roomCode);

  const lateJoiner = io(BASE);
  t.after(() => lateJoiner.close());
  await waitConnected(lateJoiner);
  const joinRes = await emitAck(lateJoiner, 'room:join', { roomCode, name: 'LateJoiner' });

  assert.equal(joinRes.ok, true);
  assert.equal(joinRes.state.playback.status, 'paused');
  assert.equal(joinRes.state.playback.positionSec, 0);
});

test('reconnect while playing: rejoining with the same room code/name after a disconnect receives the current (possibly advanced) playback state', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  await uploadTrack(tokenRes.token, wavBytes);
  await emitAck(host, 'playback:play', {});

  // A participant joins, then "disconnects" (network drop) and reconnects
  // with a brand-new socket, exactly as Room.jsx's reconnect handler does -
  // rejoining using the remembered roomCode/name.
  const participant = io(BASE);
  t.after(() => participant.close());
  await waitConnected(participant);
  await emitAck(participant, 'room:join', { roomCode, name: 'Participant' });
  participant.disconnect();

  await new Promise((resolve) => setTimeout(resolve, 50)); // let the disconnect land server-side

  const reconnected = io(BASE);
  t.after(() => reconnected.close());
  await waitConnected(reconnected);
  const rejoinAck = await emitAck(reconnected, 'room:join', { roomCode, name: 'Participant' });

  assert.equal(rejoinAck.ok, true);
  assert.equal(rejoinAck.state.playback.status, 'playing', 'rejoin must reflect that playback is still active');
  assert.equal(rejoinAck.state.playback.trackVersion, 1);
  // Exactly one "Participant" entry should exist - the stale pre-disconnect one must be gone.
  const participantEntries = rejoinAck.state.clients.filter((c) => c.name === 'Participant');
  assert.equal(participantEntries.length, 1);
});

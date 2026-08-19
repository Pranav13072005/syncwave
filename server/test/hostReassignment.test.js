// Unit tests for Phase 6 host reassignment logic in roomManager.js (direct,
// no server needed) plus one integration test for former-host token
// rejection (needs the live server + HTTP upload). `node --test test/`
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

// --- Direct roomManager unit tests ---

test('host disconnect promotes the longest-connected remaining member', () => {
  const room = roomManager.createRoom('host-A', 'Alice');
  roomManager.joinRoom(room.code, 'guest-B', 'Bob');
  // Bob is the only other member, so he's trivially the longest-connected
  // one once Alice (the host) leaves.
  roomManager.leaveRoom('host-A');
  const state = roomManager.toPublicState(room);
  assert.equal(state.hostId, 'guest-B');
  assert.equal(state.clients.find((c) => c.id === 'guest-B').isHost, true);
});

test('promotion picks the OLDEST remaining member, not just any member', async () => {
  const room = roomManager.createRoom('host-A2', 'Alice');
  roomManager.joinRoom(room.code, 'guest-B2', 'Bob');
  await sleep(5); // ensure a distinguishable joinedAt gap
  roomManager.joinRoom(room.code, 'guest-C2', 'Carol');
  roomManager.leaveRoom('host-A2');
  // Bob joined before Carol, so Bob (not Carol) must become host.
  assert.equal(room.hostId, 'guest-B2');
});

test('host disconnect in a single-member room clears hostId (no one to promote)', () => {
  const room = roomManager.createRoom('host-solo', 'Solo');
  roomManager.leaveRoom('host-solo');
  // Room is now empty; leaveRoom returns null and schedules cleanup, but we
  // can still inspect the room object directly since it's not deleted yet
  // (grace period). hostId should already be null.
  assert.equal(room.hostId, null);
});

test('a non-host member leaving does not trigger promotion or change hostId', () => {
  const room = roomManager.createRoom('host-A3', 'Alice');
  roomManager.joinRoom(room.code, 'guest-B3', 'Bob');
  roomManager.leaveRoom('guest-B3');
  assert.equal(room.hostId, 'host-A3');
});

test('a former host who reconnects (rejoins as a new socket id) does NOT reclaim host', () => {
  const room = roomManager.createRoom('host-old', 'Alice');
  roomManager.joinRoom(room.code, 'guest-B4', 'Bob');
  roomManager.leaveRoom('host-old'); // Alice disconnects, Bob promoted
  assert.equal(room.hostId, 'guest-B4');

  // Alice "reconnects" - in Socket.IO this is always a brand-new socket id.
  const rejoinResult = roomManager.joinRoom(room.code, 'host-old-reconnected', 'Alice');
  assert.equal(rejoinResult.room.hostId, 'guest-B4', 'Bob should remain host');
  const publicState = roomManager.toPublicState(room);
  const aliceEntry = publicState.clients.find((c) => c.id === 'host-old-reconnected');
  assert.equal(aliceEntry.isHost, false, 'Alice returns as a normal participant');
});

// --- Integration test: former host's upload token rejected after reassignment ---

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

test('a former host token is rejected at upload time after host ownership changes', async (t) => {
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

  // Host obtains a valid upload token while still host.
  const tokenRes = await emitAck(host, 'track:requestUploadToken', {});
  assert.equal(tokenRes.ok, true);

  // Host disconnects, triggering promotion of Guest to host.
  const guestBecomesHostPromise = new Promise((resolve) => {
    guest.on('room:update', (state) => {
      if (state.hostId === guest.id) resolve(state);
    });
  });
  host.disconnect();
  await guestBecomesHostPromise;

  // The OLD host's token (issued before reassignment) must now be rejected,
  // even though it hasn't expired and was never explicitly used.
  const uploadResult = await uploadTrack(tokenRes.token, wavBytes);
  assert.equal(uploadResult.status, 403);
  assert.equal(uploadResult.data.error, 'INVALID_TOKEN');
});

test('after reassignment, the NEW host can obtain a valid token and upload successfully', async (t) => {
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

  const guestBecomesHostPromise = new Promise((resolve) => {
    guest.on('room:update', (state) => {
      if (state.hostId === guest.id) resolve(state);
    });
  });
  host.disconnect();
  await guestBecomesHostPromise;

  const tokenRes = await emitAck(guest, 'track:requestUploadToken', {});
  assert.equal(tokenRes.ok, true, 'the newly promoted host should be able to request a token');

  const uploadResult = await uploadTrack(tokenRes.token, wavBytes);
  assert.equal(uploadResult.status, 200);
  assert.equal(uploadResult.data.ok, true);
});

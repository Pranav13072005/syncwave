// Integration tests for Phase 5's playback:driftReport against a REAL
// running server. Requires the backend already running: `npm start`
// (default http://localhost:3001, override with SYNCWAVE_SERVER_URL).
const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const BASE = process.env.SYNCWAVE_SERVER_URL || 'http://localhost:3001';

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

test('a new client starts with null drift diagnostics', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  assert.equal(createRes.state.clients[0].driftMs, null);
  assert.equal(createRes.state.clients[0].driftCorrectionCount, 0);
});

test('playback:driftReport updates room state and is visible to other room members', async (t) => {
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

  const hostSeesReport = waitForRoomUpdate(host, (state) => {
    const g = state.clients.find((c) => c.name === 'Guest');
    return g?.driftMs != null;
  });

  const reportAck = await emitAck(guest, 'playback:driftReport', { driftMs: 42.5, correctionCount: 1 });
  assert.equal(reportAck.ok, true);

  const broadcast = await hostSeesReport;
  const guestEntry = broadcast.clients.find((c) => c.name === 'Guest');
  assert.equal(guestEntry.driftMs, 42.5);
  assert.equal(guestEntry.driftCorrectionCount, 1);
});

test('playback:driftReport from a socket not in any room gracefully no-ops', async (t) => {
  const lone = io(BASE);
  t.after(() => lone.close());
  await waitConnected(lone);
  const ack = await emitAck(lone, 'playback:driftReport', { driftMs: 10, correctionCount: 0 });
  assert.equal(ack.ok, false);
});

test('playback:driftReport with malformed/missing payload does not crash and normalizes to null/0', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  await emitAck(host, 'room:create', { name: 'Host' });

  const updatePromise = new Promise((resolve) => host.once('room:update', resolve));
  const ack = await emitAck(host, 'playback:driftReport', { driftMs: 'not-a-number', correctionCount: 'nope' });
  assert.equal(ack.ok, true);

  const updated = await updatePromise;
  const entry = updated.clients.find((c) => c.id === host.id);
  // Non-numeric input must be normalized to null/0, not stored as garbage.
  assert.equal(entry.driftMs, null);
  assert.equal(entry.driftCorrectionCount, 0);
});

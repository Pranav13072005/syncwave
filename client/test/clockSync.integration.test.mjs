// Integration tests for the Phase 3 clock-sync protocol against a REAL
// running server (imports the actual client module, not a reimplementation).
//
// Requires the backend to already be running: `cd server && npm start`
// (default http://localhost:3001, override with SYNCWAVE_SERVER_URL).
// These are deliberately not auto-started here: server/index.js binds its
// port as a load-time side effect and isn't structured for in-process test
// harnessing - that refactor belongs with Phase 7's test setup, not Phase 3's
// clock-sync work. Run with: node --test test/  (server must be running first)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { runClockSync } from '../src/clockSync.js';

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

test('runClockSync produces a synced result with a small offset/RTT against the real server', async (t) => {
  const socket = io(BASE);
  t.after(() => socket.close());
  await waitConnected(socket);

  const result = await runClockSync(socket, { sampleCount: 9 });
  assert.equal(result.status, 'synced');
  assert.ok(result.sampleCount >= 7, `expected most samples to succeed, got ${result.sampleCount}/9`);
  assert.ok(Math.abs(result.offsetMs) < 200, `offset ${result.offsetMs}ms should be small on a local/LAN link`);
  assert.ok(result.rttMs < 200, `rtt ${result.rttMs}ms should be small on a local/LAN link`);
});

test('runClockSync fails gracefully (no throw) when the server is unreachable', async (t) => {
  const socket = io('http://localhost:59999', { reconnection: false, timeout: 500 });
  t.after(() => socket.close());

  const result = await runClockSync(socket, { sampleCount: 3, timeoutMs: 500, interSampleDelayMs: 0 });
  assert.equal(result.status, 'failed');
  assert.equal(result.offsetMs, null);
  assert.equal(result.rttMs, null);
});

test('clock:report updates room state and is visible to other room members', async (t) => {
  const host = io(BASE);
  const guest = io(BASE);
  t.after(() => {
    host.close();
    guest.close();
  });

  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  assert.equal(createRes.state.clients[0].syncStatus, 'unsynced');
  assert.equal(createRes.state.clients[0].rtt, null);

  await waitConnected(guest);
  await emitAck(guest, 'room:join', { roomCode: createRes.state.roomCode, name: 'Guest' });

  const syncedUpdate = waitForRoomUpdate(host, (state) => {
    const g = state.clients.find((c) => c.name === 'Guest');
    return g?.syncStatus === 'synced';
  });

  const syncResult = await runClockSync(guest);
  const reportAck = await emitAck(guest, 'clock:report', {
    rtt: syncResult.rttMs,
    offsetMs: syncResult.offsetMs,
    status: syncResult.status,
  });
  assert.equal(reportAck.ok, true);

  const broadcast = await syncedUpdate;
  const guestEntry = broadcast.clients.find((c) => c.name === 'Guest');
  assert.equal(guestEntry.syncStatus, 'synced');
  assert.equal(typeof guestEntry.rtt, 'number');
  assert.equal(typeof guestEntry.clockOffsetMs, 'number');
});

test('clock:report from a socket not in any room no-ops gracefully', async (t) => {
  const socket = io(BASE);
  t.after(() => socket.close());
  await waitConnected(socket);

  const ack = await emitAck(socket, 'clock:report', { rtt: 10, offsetMs: 1, status: 'synced' });
  assert.equal(ack.ok, false);
});

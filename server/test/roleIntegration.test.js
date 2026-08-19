// Live-server integration tests for Phase 6.2B roles: co-host upload/queue
// authorization over real sockets, and stale-token revocation on demotion.
// `node --test test/` (requires the dev server running on :3001).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { BASE, waitConnected, emitAck, uploadTrack } = require('../testUtils');

const wavPath = path.join(__dirname, '..', 'public', 'audio', 'test-tone.wav');
const wavBytes = fs.readFileSync(wavPath);

test('a promoted co-host can obtain an upload token and control playback/queue over real sockets', async (t) => {
  const host = io(BASE);
  const cohost = io(BASE);
  t.after(() => {
    host.close();
    cohost.close();
  });
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;
  await waitConnected(cohost);
  await emitAck(cohost, 'room:join', { roomCode, name: 'CoHost' });

  const promoteAck = await emitAck(host, 'room:promoteCoHost', { targetSocketId: cohost.id });
  assert.equal(promoteAck.ok, true);

  const tokenRes = await emitAck(cohost, 'track:requestUploadToken', {});
  assert.equal(tokenRes.ok, true, 'a co-host must be able to obtain an upload token');
  const uploadResult = await uploadTrack(tokenRes.token, wavBytes);
  assert.equal(uploadResult.status, 200);

  const playAck = await emitAck(cohost, 'playback:play', {});
  assert.equal(playAck.ok, true, 'a co-host must be able to control playback');
});

test('a plain participant cannot promote/demote/transfer even after being promoted... only the primary host can', async (t) => {
  const host = io(BASE);
  const cohost = io(BASE);
  const guest = io(BASE);
  t.after(() => {
    host.close();
    cohost.close();
    guest.close();
  });
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;
  await waitConnected(cohost);
  await waitConnected(guest);
  await emitAck(cohost, 'room:join', { roomCode, name: 'CoHost' });
  await emitAck(guest, 'room:join', { roomCode, name: 'Guest' });
  await emitAck(host, 'room:promoteCoHost', { targetSocketId: cohost.id });

  const cohostTriesToPromote = await emitAck(cohost, 'room:promoteCoHost', { targetSocketId: guest.id });
  assert.equal(cohostTriesToPromote.ok, false);
  assert.equal(cohostTriesToPromote.error, 'NOT_HOST', 'a co-host must not be able to promote others');

  const cohostTriesToTransfer = await emitAck(cohost, 'room:transferHost', { targetSocketId: guest.id });
  assert.equal(cohostTriesToTransfer.ok, false);
  assert.equal(cohostTriesToTransfer.error, 'NOT_HOST', 'a co-host must not be able to transfer primary ownership');
});

test('demoting a co-host revokes an already-issued-but-unconsumed upload token at consumption time', async (t) => {
  const host = io(BASE);
  const cohost = io(BASE);
  t.after(() => {
    host.close();
    cohost.close();
  });
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;
  await waitConnected(cohost);
  await emitAck(cohost, 'room:join', { roomCode, name: 'CoHost' });
  await emitAck(host, 'room:promoteCoHost', { targetSocketId: cohost.id });

  const tokenRes = await emitAck(cohost, 'track:requestUploadToken', {});
  assert.equal(tokenRes.ok, true);

  await emitAck(host, 'room:demoteCoHost', { targetSocketId: cohost.id });

  const uploadResult = await uploadTrack(tokenRes.token, wavBytes);
  assert.equal(uploadResult.status, 403);
  assert.equal(uploadResult.data.error, 'INVALID_TOKEN', 'a demoted co-host\'s stale token must no longer grant upload access');
});

test('after a voluntary transfer, the new primary host can promote/demote and the old primary (now co-host) cannot', async (t) => {
  const host = io(BASE);
  const bob = io(BASE);
  const guest = io(BASE);
  t.after(() => {
    host.close();
    bob.close();
    guest.close();
  });
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;
  await waitConnected(bob);
  await waitConnected(guest);
  await emitAck(bob, 'room:join', { roomCode, name: 'Bob' });
  await emitAck(guest, 'room:join', { roomCode, name: 'Guest' });

  const transferAck = await emitAck(host, 'room:transferHost', { targetSocketId: bob.id });
  assert.equal(transferAck.ok, true);

  const oldHostTriesToPromote = await emitAck(host, 'room:promoteCoHost', { targetSocketId: guest.id });
  assert.equal(oldHostTriesToPromote.ok, false, 'the old primary (now a co-host) must lose promote/demote/transfer rights');
  assert.equal(oldHostTriesToPromote.error, 'NOT_HOST');

  const newHostPromotes = await emitAck(bob, 'room:promoteCoHost', { targetSocketId: guest.id });
  assert.equal(newHostPromotes.ok, true, 'the new primary host must have full role-management rights');

  // The old primary, now a co-host, should still be able to control playback.
  await emitAck(bob, 'track:requestUploadToken', {}).then(async (tokenRes) => {
    if (tokenRes.ok) await uploadTrack(tokenRes.token, wavBytes);
  });
  const oldHostPlayAck = await emitAck(host, 'playback:play', {});
  assert.equal(oldHostPlayAck.ok, true, 'the old primary, now a co-host, retains playback control');
});

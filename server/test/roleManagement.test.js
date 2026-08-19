// Phase 6.2B tests for primary-host / co-host / participant roles: promote,
// demote, transfer, failover preferring a co-host, and authorization
// boundaries. `node --test test/` - pure roomManager tests only (no live
// server needed); the live-server upload-token-revocation test lives in
// roleIntegration.test.js alongside the others that need a real HTTP round trip.
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

// --- promote / demote ---

test('promoteToCoHost adds the target to coHostIds; reflected as isCoHost in public state', () => {
  const room = roomManager.createRoom('role-1', 'Host');
  roomManager.joinRoom(room.code, 'role-1-guest', 'Guest');

  const result = roomManager.promoteToCoHost(room.code, 'role-1-guest');
  assert.equal(result.error, undefined);
  assert.equal(room.coHostIds.has('role-1-guest'), true);

  const publicState = roomManager.toPublicState(room);
  const guestEntry = publicState.clients.find((c) => c.id === 'role-1-guest');
  assert.equal(guestEntry.isCoHost, true);
  assert.equal(guestEntry.isHost, false);
});

test('promoteToCoHost rejects a target not in the room', () => {
  const room = roomManager.createRoom('role-2', 'Host');
  const result = roomManager.promoteToCoHost(room.code, 'nobody');
  assert.equal(result.error, 'TARGET_NOT_IN_ROOM');
});

test('promoteToCoHost rejects promoting the primary host (already has full rights)', () => {
  const room = roomManager.createRoom('role-3', 'Host');
  const result = roomManager.promoteToCoHost(room.code, 'role-3');
  assert.equal(result.error, 'ALREADY_PRIMARY_HOST');
});

test('demoteToParticipant removes co-host privileges', () => {
  const room = roomManager.createRoom('role-4', 'Host');
  roomManager.joinRoom(room.code, 'role-4-guest', 'Guest');
  roomManager.promoteToCoHost(room.code, 'role-4-guest');
  assert.equal(room.coHostIds.has('role-4-guest'), true);

  roomManager.demoteToParticipant(room.code, 'role-4-guest');
  assert.equal(room.coHostIds.has('role-4-guest'), false);
  const publicState = roomManager.toPublicState(room);
  assert.equal(publicState.clients.find((c) => c.id === 'role-4-guest').isCoHost, false);
});

// --- co-host CAN control playback/queue ---

test('a co-host is accepted by the shared requireController check (playback/queue authorization)', () => {
  const room = roomManager.createRoom('role-5', 'Host');
  roomManager.joinRoom(room.code, 'role-5-cohost', 'CoHost');
  roomManager.promoteToCoHost(room.code, 'role-5-cohost');

  const { requireController, requireHost } = require('../socketUtils');
  const fakeSocket = { id: 'role-5-cohost', rooms: new Set(['role-5-cohost', room.code]) };
  const controllerCheck = requireController(fakeSocket);
  assert.equal(controllerCheck.error, undefined, 'a co-host must pass requireController');

  const hostCheck = requireHost(fakeSocket);
  assert.equal(hostCheck.error, 'NOT_HOST', 'a co-host must NOT pass the strict primary-only requireHost (role management)');
});

test('a plain participant fails requireController the same way a total stranger would (NOT_HOST)', () => {
  const room = roomManager.createRoom('role-6', 'Host');
  roomManager.joinRoom(room.code, 'role-6-guest', 'Guest');
  const { requireController } = require('../socketUtils');
  const fakeSocket = { id: 'role-6-guest', rooms: new Set(['role-6-guest', room.code]) };
  assert.equal(requireController(fakeSocket).error, 'NOT_HOST');
});

// --- explicit transfer ---

test('transferPrimaryHost: new primary gets full control, old primary becomes a co-host (not demoted to participant)', () => {
  const room = roomManager.createRoom('role-7', 'Host');
  roomManager.joinRoom(room.code, 'role-7-bob', 'Bob');

  const result = roomManager.transferPrimaryHost(room.code, 'role-7-bob', 'role-7');
  assert.equal(result.error, undefined);
  assert.equal(room.hostId, 'role-7-bob', 'Bob is now primary host');
  assert.equal(room.coHostIds.has('role-7'), true, 'the old primary becomes a co-host, for room continuity');
  assert.equal(room.coHostIds.has('role-7-bob'), false, 'the new primary is not ALSO listed as a co-host');

  const publicState = roomManager.toPublicState(room);
  assert.equal(publicState.clients.find((c) => c.id === 'role-7-bob').isHost, true);
  assert.equal(publicState.clients.find((c) => c.id === 'role-7').isCoHost, true);
});

test('transferPrimaryHost rejects transferring to a target not in the room', () => {
  const room = roomManager.createRoom('role-8', 'Host');
  const result = roomManager.transferPrimaryHost(room.code, 'nobody', 'role-8');
  assert.equal(result.error, 'TARGET_NOT_IN_ROOM');
});

test('transferPrimaryHost rejects transferring to yourself', () => {
  const room = roomManager.createRoom('role-9', 'Host');
  const result = roomManager.transferPrimaryHost(room.code, 'role-9', 'role-9');
  assert.equal(result.error, 'ALREADY_PRIMARY_HOST');
});

// --- failover prefers a connected co-host ---

test('primary-host disconnect promotes the oldest-connected CO-HOST over a longer-connected plain participant', () => {
  const room = roomManager.createRoom('role-10', 'Host');
  roomManager.joinRoom(room.code, 'role-10-early-participant', 'EarlyParticipant'); // joins before the co-host, would win the OLD longest-connected rule
  roomManager.joinRoom(room.code, 'role-10-cohost', 'CoHost');
  roomManager.promoteToCoHost(room.code, 'role-10-cohost');

  const result = roomManager.leaveRoom('role-10'); // primary host disconnects
  assert.equal(result.hostId, 'role-10-cohost', 'the co-host must be promoted even though the participant joined earlier');
  assert.equal(room.coHostIds.has('role-10-cohost'), false, 'the newly-promoted primary is no longer ALSO listed as a co-host');
});

test('primary-host disconnect with no co-host falls back to the oldest-connected participant (unchanged Phase 6 behavior)', () => {
  const room = roomManager.createRoom('role-11', 'Host');
  roomManager.joinRoom(room.code, 'role-11-first', 'First');
  roomManager.joinRoom(room.code, 'role-11-second', 'Second');

  const result = roomManager.leaveRoom('role-11');
  assert.equal(result.hostId, 'role-11-first', 'no co-hosts exist, so the longest-connected member of any role is promoted, as before Phase 6.2B');
});

test('a former primary host reconnecting (new socket.id) returns as an ordinary participant, not auto-restored', () => {
  const room = roomManager.createRoom('role-12', 'Host');
  roomManager.joinRoom(room.code, 'role-12-cohost', 'CoHost');
  roomManager.promoteToCoHost(room.code, 'role-12-cohost');
  roomManager.leaveRoom('role-12'); // failover promotes the co-host
  assert.equal(room.hostId, 'role-12-cohost');

  const rejoinResult = roomManager.joinRoom(room.code, 'role-12-NEW-SOCKET-ID', 'Host');
  assert.equal(rejoinResult.room.hostId, 'role-12-cohost', 'the reconnecting former host must NOT reclaim primary status');
  assert.equal(room.coHostIds.has('role-12-NEW-SOCKET-ID'), false, 'and must not be auto-restored as a co-host either');
});

// --- queue-only mutation and playback authorization end to end (roomManager level) ---

test('after promotion, a co-host\'s issuePlayCommand-equivalent authorization boundary works alongside normal roomManager playback calls', () => {
  const room = roomManager.createRoom('role-13', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.joinRoom(room.code, 'role-13-cohost', 'CoHost');
  roomManager.promoteToCoHost(room.code, 'role-13-cohost');

  // roomManager.issuePlayCommand itself has no authorization concept (that's
  // requireController's job in the handler layer, already verified above) -
  // this just confirms the co-host's role survives normal playback activity.
  const playResult = roomManager.issuePlayCommand(room.code);
  assert.equal(playResult.error, undefined);
  assert.equal(room.coHostIds.has('role-13-cohost'), true, 'issuing playback commands must not affect role assignment');
});

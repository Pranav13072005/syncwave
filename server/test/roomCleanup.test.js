// Tests for Phase 6's empty-room grace-period cleanup. Uses
// setRoomCleanupGraceMsForTesting to avoid waiting 30 real seconds.
// `node --test test/`
const test = require('node:test');
const assert = require('node:assert/strict');
const roomManager = require('../roomManager');
const uploadTokens = require('../uploadTokens');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a room is NOT deleted immediately when it becomes empty - it survives the grace period', () => {
  roomManager.setRoomCleanupGraceMsForTesting(60_000); // long enough that this test's own execution can't race it
  const room = roomManager.createRoom('solo-1', 'Solo');
  roomManager.leaveRoom('solo-1');
  assert.equal(roomManager.getRoom(room.code), room, 'room object must still be findable during its grace period');
  assert.equal(roomManager.isPendingCleanup(room), true);
});

test('rejoining an empty room during its grace period cancels cleanup and restores the room', () => {
  roomManager.setRoomCleanupGraceMsForTesting(60_000);
  const room = roomManager.createRoom('solo-2', 'Solo');
  roomManager.leaveRoom('solo-2');
  assert.equal(roomManager.isPendingCleanup(room), true);

  const rejoinResult = roomManager.joinRoom(room.code, 'rejoiner-1', 'Returner');
  assert.equal(rejoinResult.error, undefined);
  assert.equal(roomManager.isPendingCleanup(room), false, 'cleanup must be cancelled on rejoin');
  assert.equal(roomManager.getRoom(room.code), room, 'the SAME room object is restored, not a fresh one');
});

test('the first client to rejoin an empty room during its grace period becomes host', () => {
  roomManager.setRoomCleanupGraceMsForTesting(60_000);
  const room = roomManager.createRoom('solo-3', 'Solo');
  roomManager.leaveRoom('solo-3'); // room now empty, hostId already null
  assert.equal(room.hostId, null);

  const rejoinResult = roomManager.joinRoom(room.code, 'rejoiner-2', 'NewPerson');
  assert.equal(rejoinResult.room.hostId, 'rejoiner-2');
  const publicState = roomManager.toPublicState(room);
  assert.equal(publicState.clients.find((c) => c.id === 'rejoiner-2').isHost, true);
});

test('preserved room state (track/playback) survives a grace-period rejoin, not reset', () => {
  roomManager.setRoomCleanupGraceMsForTesting(60_000);
  const room = roomManager.createRoom('solo-4', 'Solo');
  roomManager.setTrack(room.code, {
    originalName: 'song.wav',
    mimeType: 'audio/wav',
    size: 100,
    storedFilename: 'song.wav',
    url: '/uploads/song.wav',
    uploadedAt: Date.now(),
  });
  const trackVersionBefore = room.track.version;
  roomManager.leaveRoom('solo-4');
  roomManager.joinRoom(room.code, 'rejoiner-3', 'NewPerson');
  assert.equal(room.track.version, trackVersionBefore, 'track metadata must be preserved across the grace period');
});

test('when the grace period actually expires with the room still empty, the room is deleted and the deletion listener fires', async () => {
  roomManager.setRoomCleanupGraceMsForTesting(50); // short, so the test doesn't take long
  const room = roomManager.createRoom('solo-5', 'Solo');

  let deletedRoom = null;
  roomManager.onRoomDeleted((r) => {
    deletedRoom = r;
  });

  roomManager.leaveRoom('solo-5');
  assert.equal(roomManager.getRoom(room.code), room, 'still present immediately after emptying');

  await sleep(150); // well past the 50ms grace period

  assert.equal(roomManager.getRoom(room.code), null, 'room must be gone after the grace period expires');
  assert.equal(deletedRoom, room, 'the onRoomDeleted listener must have fired with the deleted room');

  roomManager.onRoomDeleted(null); // reset the listener so later tests aren't affected
  roomManager.setRoomCleanupGraceMsForTesting(30_000); // restore default-ish for subsequent tests in this process
});

test('final cleanup purges the room\'s outstanding upload tokens (authorization state)', async () => {
  roomManager.setRoomCleanupGraceMsForTesting(50);
  const room = roomManager.createRoom('solo-7', 'Solo');
  const token = uploadTokens.createToken(room.code, 'solo-7');

  roomManager.leaveRoom('solo-7');
  await sleep(150);

  assert.equal(roomManager.getRoom(room.code), null, 'room should be fully deleted');
  const consumed = uploadTokens.consumeToken(token);
  assert.equal(consumed, null, 'a token belonging to a deleted room must no longer be consumable');

  roomManager.setRoomCleanupGraceMsForTesting(30_000);
});

test('a room that never empties is never scheduled for cleanup', () => {
  roomManager.setRoomCleanupGraceMsForTesting(60_000);
  const room = roomManager.createRoom('solo-6', 'Solo');
  roomManager.joinRoom(room.code, 'guest-6', 'Guest');
  roomManager.leaveRoom('guest-6'); // room still has the host - not empty
  assert.equal(roomManager.isPendingCleanup(room), false);
});

test('rejoining with a genuinely unknown room code still fails with ROOM_NOT_FOUND (not silently creating one)', () => {
  const result = roomManager.joinRoom('ZZZZZ', 'someone', 'Someone');
  assert.equal(result.error, 'ROOM_NOT_FOUND');
});

test('repeated disconnect/rejoin cycles never leave duplicate or stale members', () => {
  roomManager.setRoomCleanupGraceMsForTesting(60_000);
  const room = roomManager.createRoom('cycler-host', 'Host');

  // Simulate the same participant reconnecting several times in a row -
  // each reconnect is a brand-new socket id (Socket.IO never reuses one),
  // and the OLD id is removed via leaveRoom before/as the new one joins.
  let currentId = 'cycler-1';
  roomManager.joinRoom(room.code, currentId, 'Wanderer');
  assert.equal(room.clients.size, 2); // host + Wanderer

  for (let i = 2; i <= 5; i++) {
    roomManager.leaveRoom(currentId);
    currentId = `cycler-${i}`;
    roomManager.joinRoom(room.code, currentId, 'Wanderer');
    assert.equal(room.clients.size, 2, `expected exactly 2 members after reconnect cycle ${i}, no duplicates accumulated`);
  }

  const publicState = roomManager.toPublicState(room);
  const wandererEntries = publicState.clients.filter((c) => c.name === 'Wanderer');
  assert.equal(wandererEntries.length, 1, 'only the latest connection for "Wanderer" should be present');
});

// Pure/direct tests for the Phase 4 authoritative playback-state logic in
// roomManager.js: canonical-position math, version increments, and command
// validation. No network involved - always safe to run: `node --test test/`
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

test('createRoom starts with default paused playback at position 0, version 0', () => {
  const room = roomManager.createRoom('sock-1', 'Host');
  assert.equal(room.playback.status, 'paused');
  assert.equal(room.playback.positionSec, 0);
  assert.equal(room.playback.anchorServerTime, null);
  assert.equal(room.playback.version, 0);
  assert.equal(room.playback.trackVersion, null);
});

test('playback commands reject when the room has no track (NO_TRACK)', () => {
  const room = roomManager.createRoom('sock-2', 'Host');
  assert.equal(roomManager.issuePlayCommand(room.code).error, 'NO_TRACK');
  assert.equal(roomManager.issuePauseCommand(room.code).error, 'NO_TRACK');
  assert.equal(roomManager.issueSeekCommand(room.code, 5).error, 'NO_TRACK');
});

test('playback commands reject an unknown room code (NO_ROOM)', () => {
  assert.equal(roomManager.issuePlayCommand('NOPE1').error, 'NO_ROOM');
  assert.equal(roomManager.issuePauseCommand('NOPE1').error, 'NO_ROOM');
  assert.equal(roomManager.issueSeekCommand('NOPE1', 5).error, 'NO_ROOM');
});

test('setTrack resets playback to paused/0 and bumps the playback version', () => {
  const room = roomManager.createRoom('sock-3', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  assert.equal(room.playback.status, 'paused');
  assert.equal(room.playback.positionSec, 0);
  assert.equal(room.playback.version, 1); // bumped from 0
  assert.equal(room.playback.trackVersion, 1);
});

test('issuePlayCommand transitions to playing with a future anchorServerTime and increments version', () => {
  const room = roomManager.createRoom('sock-4', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta()); // playback.version -> 1
  const before = Date.now();
  const result = roomManager.issuePlayCommand(room.code);
  assert.equal(result.room.playback.status, 'playing');
  assert.ok(result.targetServerTime > before, 'target time is in the future');
  assert.equal(result.room.playback.anchorServerTime, result.targetServerTime);
  assert.equal(result.room.playback.version, 2); // 1 (setTrack) + 1 (play)
  assert.equal(result.room.playback.trackVersion, room.track.version);
});

test('issuePauseCommand after play increments version again and preserves trackVersion', () => {
  const room = roomManager.createRoom('sock-5', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.issuePlayCommand(room.code);
  const result = roomManager.issuePauseCommand(room.code);
  assert.equal(result.room.playback.status, 'paused');
  assert.equal(result.room.playback.version, 3); // 1 + 1 (play) + 1 (pause)
  assert.equal(result.room.playback.trackVersion, room.track.version);
});

test('issueSeekCommand preserves current status (playing stays playing, paused stays paused)', () => {
  const playingRoom = roomManager.createRoom('sock-6', 'Host');
  roomManager.setTrack(playingRoom.code, makeTrackMeta());
  roomManager.issuePlayCommand(playingRoom.code);
  const seekWhilePlaying = roomManager.issueSeekCommand(playingRoom.code, 42);
  assert.equal(seekWhilePlaying.room.playback.status, 'playing');
  assert.equal(seekWhilePlaying.room.playback.positionSec, 42);

  const pausedRoom = roomManager.createRoom('sock-7', 'Host');
  roomManager.setTrack(pausedRoom.code, makeTrackMeta());
  const seekWhilePaused = roomManager.issueSeekCommand(pausedRoom.code, 10);
  assert.equal(seekWhilePaused.room.playback.status, 'paused');
  assert.equal(seekWhilePaused.room.playback.positionSec, 10);
});

test('issueSeekCommand rejects negative, NaN, and non-finite positions gracefully', () => {
  const room = roomManager.createRoom('sock-8', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  assert.equal(roomManager.issueSeekCommand(room.code, -5).error, 'INVALID_SEEK_POSITION');
  assert.equal(roomManager.issueSeekCommand(room.code, NaN).error, 'INVALID_SEEK_POSITION');
  assert.equal(roomManager.issueSeekCommand(room.code, Infinity).error, 'INVALID_SEEK_POSITION');
  assert.equal(roomManager.issueSeekCommand(room.code, 'abc').error, 'INVALID_SEEK_POSITION');
});

test('issueSeekCommand rejects positions beyond the known track duration', () => {
  const room = roomManager.createRoom('sock-9', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('sock-9', room.track.version, 30.5); // host reports a 30.5s decoded buffer
  assert.equal(room.track.durationSec, 30.5);
  assert.equal(roomManager.issueSeekCommand(room.code, 30.6).error, 'SEEK_OUT_OF_RANGE');
  const okResult = roomManager.issueSeekCommand(room.code, 30.5);
  assert.equal(okResult.room.playback.positionSec, 30.5);
});

test('issueSeekCommand allows any non-negative position when duration is not yet known', () => {
  const room = roomManager.createRoom('sock-10', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const result = roomManager.issueSeekCommand(room.code, 99999);
  assert.equal(result.error, undefined);
  assert.equal(result.room.playback.positionSec, 99999);
});

test('getCanonicalPosition freezes the position while paused, regardless of elapsed time', () => {
  const room = roomManager.createRoom('sock-11', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.issuePlayCommand(room.code);
  const pauseResult = roomManager.issuePauseCommand(room.code);
  const pausedPosition = pauseResult.room.playback.positionSec;
  const muchLater = pauseResult.targetServerTime + 100000;
  assert.equal(roomManager.getCanonicalPosition(room, muchLater), pausedPosition);
});

test('getCanonicalPosition extrapolates forward correctly while playing', () => {
  const room = roomManager.createRoom('sock-12', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const playResult = roomManager.issuePlayCommand(room.code);
  const twoSecondsLater = playResult.targetServerTime + 2000;
  const pos = roomManager.getCanonicalPosition(room, twoSecondsLater);
  assert.ok(Math.abs(pos - 2) < 0.001, `expected ~2s elapsed, got ${pos}`);
});

test('getCanonicalPosition clamps elapsed time to zero for a timestamp before the anchor', () => {
  const room = roomManager.createRoom('sock-13', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  const playResult = roomManager.issuePlayCommand(room.code);
  const beforeAnchor = playResult.targetServerTime - 500; // command lands before playback would even start
  const pos = roomManager.getCanonicalPosition(room, beforeAnchor);
  assert.equal(pos, playResult.room.playback.positionSec);
});

test('a seek issued while playing then paused correctly carries the sought position forward', () => {
  const room = roomManager.createRoom('sock-14', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.issuePlayCommand(room.code);
  roomManager.issueSeekCommand(room.code, 55);
  const pauseResult = roomManager.issuePauseCommand(room.code);
  // Pause happens ~1s after the seek's anchor, so expect ~55 + ~1s of extrapolation.
  assert.ok(pauseResult.room.playback.positionSec >= 55, `expected position >= 55, got ${pauseResult.room.playback.positionSec}`);
  assert.ok(pauseResult.room.playback.positionSec < 57, `expected position reasonably close to 55, got ${pauseResult.room.playback.positionSec}`);
});

// --- natural-completion-related: canonical position clamping ---

test('canonical position clamps exactly at duration once elapsed time would carry it past the end', () => {
  const room = roomManager.createRoom('sock-15', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('sock-15', room.track.version, 180); // 180s track
  const playResult = roomManager.issuePlayCommand(room.code);
  // Exactly at the moment it would naturally end (180s after the anchor).
  const exactEnd = playResult.targetServerTime + 180 * 1000;
  assert.equal(roomManager.getCanonicalPosition(room, exactEnd), 180);
});

test('canonical position never exceeds duration, no matter how far past the end "now" is', () => {
  const room = roomManager.createRoom('sock-16', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('sock-16', room.track.version, 180);
  const playResult = roomManager.issuePlayCommand(room.code);
  const wayPastTheEnd = playResult.targetServerTime + 999 * 1000; // 999s later, track is 180s
  assert.equal(roomManager.getCanonicalPosition(room, wayPastTheEnd), 180);
});

test('canonical position is unaffected by clamping when duration is unknown or not yet reached', () => {
  const room = roomManager.createRoom('sock-17', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  // No duration reported yet - nothing to clamp against.
  const playResult = roomManager.issuePlayCommand(room.code);
  const fiveSecondsLater = playResult.targetServerTime + 5000;
  assert.ok(Math.abs(roomManager.getCanonicalPosition(room, fiveSecondsLater) - 5) < 0.001);
});

// --- Play restart-from-0 behavior (Requirement 10) ---

test('Play restarts from 0 when the authoritative position is already at the natural end of the track', () => {
  const room = roomManager.createRoom('sock-18', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('sock-18', room.track.version, 10); // short 10s track
  // Simulate the room having already naturally completed: paused at duration.
  room.playback = { status: 'paused', positionSec: 10, anchorServerTime: Date.now(), version: room.playback.version + 1, trackVersion: room.track.version };

  const replayResult = roomManager.issuePlayCommand(room.code);
  assert.equal(replayResult.room.playback.status, 'playing');
  assert.equal(replayResult.room.playback.positionSec, 0, 'must restart from the beginning, not try to start at/past the track duration');
  // Still uses the normal future-scheduled mechanism - unchanged lead behavior.
  assert.ok(replayResult.targetServerTime > Date.now());
});

test('a prompt, normal Play from a mid-track position is NOT affected by the restart-from-0 logic', () => {
  const room = roomManager.createRoom('sock-19', 'Host');
  roomManager.setTrack(room.code, makeTrackMeta());
  roomManager.setReady('sock-19', room.track.version, 180);
  const seekResult = roomManager.issueSeekCommand(room.code, 42); // paused at 42s, well short of the 180s duration
  assert.equal(seekResult.room.playback.status, 'paused');

  const playResult = roomManager.issuePlayCommand(room.code);
  assert.equal(playResult.room.playback.status, 'playing');
  assert.equal(playResult.room.playback.positionSec, 42, 'a normal resume must start from where it was left, not be reset to 0');
});

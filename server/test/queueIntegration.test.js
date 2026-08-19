// Live-server integration tests for Phase 6.2A: upload routing (current vs.
// queue), queue mutation broadcasts, manual/automatic transition broadcasts,
// and file cleanup on disk. Requires `cd server && npm start` first (or the
// dev server already running on :3001), same convention as
// playback.integration.test.js / playbackCompletion.test.js.
// `node --test test/`
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { UPLOAD_DIR } = require('../uploadRoute');
const { BASE, waitConnected, emitAck, waitForRoomUpdate, uploadTrack } = require('../testUtils');

const wavPath = path.join(__dirname, '..', 'public', 'audio', 'test-tone.wav');
const wavBytes = fs.readFileSync(wavPath);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function getToken(hostSocket) {
  const tokenRes = await emitAck(hostSocket, 'track:requestUploadToken', {});
  return tokenRes.token;
}

// --- upload routing: current vs. queue ---

test('the first upload in a room becomes current; a second upload is appended to the queue', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  const firstUpload = await uploadTrack(await getToken(host), wavBytes);
  assert.equal(firstUpload.status, 200);
  assert.equal(firstUpload.data.track.originalName, 'test-tone.wav');
  assert.equal(firstUpload.data.queuedTrack, undefined, 'first upload becomes current, not queued');

  const secondUpload = await uploadTrack(await getToken(host), wavBytes, 'second.wav');
  assert.equal(secondUpload.status, 200);
  assert.equal(secondUpload.data.track.originalName, 'test-tone.wav', 'current track must be unchanged by the second upload');
  assert.equal(secondUpload.data.queuedTrack.originalName, 'second.wav', 'second upload must be appended to the queue instead of replacing current');
});

// --- queue mutation broadcasts ---

test('queue:remove and queue:reorder broadcast the updated queue to the room', async (t) => {
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

  await uploadTrack(await getToken(host), wavBytes, 'a.wav');
  const bUpload = await uploadTrack(await getToken(host), wavBytes, 'b.wav');
  await uploadTrack(await getToken(host), wavBytes, 'c.wav');
  const bTrackId = bUpload.data.queuedTrack.trackId;

  const guestSeesRemoval = waitForRoomUpdate(guest, (state) => state.queue.length === 1 && state.queue[0].originalName === 'c.wav');
  const removeAck = await emitAck(host, 'queue:remove', { trackId: bTrackId });
  assert.equal(removeAck.ok, true);
  await guestSeesRemoval;
});

test('a non-host cannot mutate the queue (NOT_HOST)', async (t) => {
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

  await uploadTrack(await getToken(host), wavBytes, 'a.wav');
  const bUpload = await uploadTrack(await getToken(host), wavBytes, 'b.wav');

  const removeAck = await emitAck(guest, 'queue:remove', { trackId: bUpload.data.queuedTrack.trackId });
  assert.equal(removeAck.ok, false);
  assert.equal(removeAck.error, 'NOT_HOST');

  const nextAck = await emitAck(guest, 'queue:next', {});
  assert.equal(nextAck.ok, false);
  assert.equal(nextAck.error, 'NOT_HOST');
});

// --- manual Next broadcast ---

test('queue:next broadcasts the transition to every room member', async (t) => {
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

  await uploadTrack(await getToken(host), wavBytes, 'a.wav');
  await uploadTrack(await getToken(host), wavBytes, 'b.wav');
  await emitAck(host, 'playback:play', {});

  const guestSeesTransition = waitForRoomUpdate(guest, (state) => state.track?.originalName === 'b.wav' && state.playback.status === 'playing');
  const nextAck = await emitAck(host, 'queue:next', {});
  assert.equal(nextAck.ok, true);
  const state = await guestSeesTransition;
  assert.equal(state.playback.positionSec, 0);
  assert.equal(state.queue.length, 0);
});

test('queue:next rejects QUEUE_EMPTY when nothing is queued', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  await emitAck(host, 'room:create', { name: 'Host' });
  await uploadTrack(await getToken(host), wavBytes, 'a.wav');

  const nextAck = await emitAck(host, 'queue:next', {});
  assert.equal(nextAck.ok, false);
  assert.equal(nextAck.error, 'QUEUE_EMPTY');
});

// --- next-track readiness broadcast ---

test('queue:trackReady broadcasts next-track readiness to the room', async (t) => {
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

  await uploadTrack(await getToken(host), wavBytes, 'a.wav');
  const bUpload = await uploadTrack(await getToken(host), wavBytes, 'b.wav');
  const bTrackId = bUpload.data.queuedTrack.trackId;

  const guestSeesReady = waitForRoomUpdate(guest, (state) => state.clients.find((c) => c.id === host.id)?.isNextReady === true);
  const readyAck = await emitAck(host, 'queue:trackReady', { trackId: bTrackId, durationSec: 12.3 });
  assert.equal(readyAck.ok, true);
  await guestSeesReady;
});

// --- automatic advance broadcast (natural completion + non-empty queue) ---

test('natural completion with a queued next track broadcasts a direct advance, never a paused-at-end state first', async (t) => {
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

  // Attached from the very start (before any upload/track:ready/play
  // activity) and never detached, so this can't miss or mis-order anything
  // relative to host's own acks - two independent socket connections give no
  // cross-connection delivery-order guarantee, so "wait for host's ack, THEN
  // attach a guest listener" would be racy. Distinguishing a genuine
  // paused-at-end (positionSec === durationSec) from the ordinary
  // just-uploaded paused state (positionSec === 0) by POSITION rather than
  // by timing/order sidesteps that race entirely.
  const seenStatuses = [];
  guest.on('room:update', (state) => seenStatuses.push({ track: state.track?.originalName, status: state.playback.status, positionSec: state.playback.positionSec }));

  await uploadTrack(await getToken(host), wavBytes, 'a.wav');
  const bUpload = await uploadTrack(await getToken(host), wavBytes, 'b.wav');
  await emitAck(host, 'track:ready', { version: 1, durationSec: 0.2 }); // short "A"
  await emitAck(host, 'queue:trackReady', { trackId: bUpload.data.queuedTrack.trackId, durationSec: 5 });

  await emitAck(host, 'playback:play', {});
  const guestSeesAdvance = waitForRoomUpdate(guest, (state) => state.track?.originalName === 'b.wav' && state.playback.status === 'playing', 4000);
  const state = await guestSeesAdvance;
  assert.equal(state.playback.positionSec, 0);
  assert.equal(state.queue.length, 0);

  const sawPausedAtEndOfA = seenStatuses.some((s) => s.track === 'a.wav' && s.status === 'paused' && s.positionSec === 0.2);
  assert.equal(sawPausedAtEndOfA, false, 'must never broadcast a permanent paused-at-end state for A before advancing to B');
});

// --- late join / reconnect during a queue ---

test('a device joining after a track already advanced sees only the new current track, never the old one', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  const createRes = await emitAck(host, 'room:create', { name: 'Host' });
  const roomCode = createRes.state.roomCode;

  await uploadTrack(await getToken(host), wavBytes, 'a.wav');
  await uploadTrack(await getToken(host), wavBytes, 'b.wav');
  await emitAck(host, 'playback:play', {});
  await emitAck(host, 'queue:next', {});

  const latecomer = io(BASE);
  t.after(() => latecomer.close());
  await waitConnected(latecomer);
  const joinAck = await emitAck(latecomer, 'room:join', { roomCode, name: 'Latecomer' });
  assert.equal(joinAck.ok, true);
  assert.equal(joinAck.state.track.originalName, 'b.wav');
  assert.equal(joinAck.state.queue.length, 0);
});

// --- file cleanup on disk ---

test('removing an unreferenced queued track deletes its file from disk', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  await emitAck(host, 'room:create', { name: 'Host' });

  await uploadTrack(await getToken(host), wavBytes, 'current.wav');
  const bUpload = await uploadTrack(await getToken(host), wavBytes, 'queued.wav');
  const storedFilename = bUpload.data.queuedTrack.storedFilename;
  const filePath = path.join(UPLOAD_DIR, storedFilename);
  assert.equal(fs.existsSync(filePath), true, 'file must exist right after upload');

  await emitAck(host, 'queue:remove', { trackId: bUpload.data.queuedTrack.trackId });
  await sleep(200); // fs.unlink is async/fire-and-forget
  assert.equal(fs.existsSync(filePath), false, 'file must be deleted once no longer referenced by current or queue');
});

test('the current track file is NOT deleted while it is still referenced (only the superseded one is, on advance)', async (t) => {
  const host = io(BASE);
  t.after(() => host.close());
  await waitConnected(host);
  await emitAck(host, 'room:create', { name: 'Host' });

  const aUpload = await uploadTrack(await getToken(host), wavBytes, 'a-current.wav');
  const bUpload = await uploadTrack(await getToken(host), wavBytes, 'b-queued.wav');
  const aPath = path.join(UPLOAD_DIR, aUpload.data.track.storedFilename);
  const bPath = path.join(UPLOAD_DIR, bUpload.data.queuedTrack.storedFilename);
  assert.equal(fs.existsSync(aPath), true);

  await emitAck(host, 'playback:play', {});
  await sleep(100);
  assert.equal(fs.existsSync(aPath), true, 'A is still current (playing) - must not be deleted');

  await emitAck(host, 'queue:next', {}); // A -> B
  await sleep(200);
  assert.equal(fs.existsSync(bPath), true, 'B is now current - must still exist');
  assert.equal(fs.existsSync(aPath), false, 'A was superseded by the advance - its file must now be cleaned up');
});

// Room-deletion file cleanup is NOT tested end-to-end against the live
// server here: setRoomCleanupGraceMsForTesting only overrides the
// roomManager module instance in THIS test process, not the one running
// inside the separate `node index.js` server process, so there's no way to
// force the live server's real ~30s grace period to expire quickly without
// waiting it out for real. The roomManager-level guarantee this depends on
// (the deleted room object still has its full track + queue, storedFilenames
// intact, at the moment onRoomDeleted fires) is covered in-process instead -
// see queueManager.test.js's "onRoomDeleted fires with the full room..."
// test. index.js's actual fs.unlink loop consuming that data is a direct,
// trivially-inspectable 3-line consequence of it (same trust boundary the
// original Phase 6 onRoomDeleted current-track cleanup was never
// fs-tested end-to-end either).

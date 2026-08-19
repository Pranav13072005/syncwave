// Socket.IO events for host-controlled queue management (remove/reorder/next)
// and per-device "next track" preload-readiness reporting. Adding a track to
// the queue is deliberately NOT a socket event here - it happens through the
// existing upload flow (server/uploadRoute.js), gated by the same upload-
// token/host-authorization mechanism as every other upload, just routed to
// the queue instead of the current-track slot when one already exists.
const fs = require('fs');
const path = require('path');
const roomManager = require('./roomManager');
const { requireController } = require('./socketUtils');
const { UPLOAD_DIR } = require('./uploadRoute');

function deleteStoredFile(storedFilename) {
  if (!storedFilename) return;
  fs.unlink(path.join(UPLOAD_DIR, storedFilename), () => {});
}

function registerQueueHandlers(io, socket) {
  socket.on('queue:remove', ({ trackId } = {}, ack) => {
    const check = requireController(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.removeFromQueue(check.room.code, trackId);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    deleteStoredFile(result.removedTrack?.storedFilename);
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });

  socket.on('queue:reorder', ({ trackId, toIndex } = {}, ack) => {
    const check = requireController(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.reorderQueue(check.room.code, trackId, toIndex);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });

  socket.on('queue:next', (_payload, ack) => {
    const check = requireController(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.issueNextCommand(check.room.code);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    deleteStoredFile(result.previousTrack?.storedFilename);
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });

  socket.on('queue:trackReady', ({ trackId, durationSec } = {}, ack) => {
    const room = roomManager.setNextReady(socket.id, trackId, durationSec);
    if (!room) {
      ack?.({ ok: false });
      return;
    }
    io.to(room.code).emit('room:update', roomManager.toPublicState(room));
    ack?.({ ok: true });
  });
}

module.exports = registerQueueHandlers;

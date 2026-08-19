// Socket.IO events for host-issued playback control (play/pause/seek).
// All state math (canonical position, versioning, future scheduling target)
// lives in roomManager.js - this file only enforces "who is allowed to ask"
// (host-only) and broadcasts the result via the existing room:update.
const roomManager = require('./roomManager');
const { requireHost } = require('./socketUtils');

function registerPlaybackHandlers(io, socket) {
  socket.on('playback:play', (_payload, ack) => {
    const check = requireHost(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.issuePlayCommand(check.room.code);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });

  socket.on('playback:pause', (_payload, ack) => {
    const check = requireHost(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.issuePauseCommand(check.room.code);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });

  socket.on('playback:seek', ({ positionSec } = {}, ack) => {
    const check = requireHost(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.issueSeekCommand(check.room.code, positionSec);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });
}

module.exports = registerPlaybackHandlers;

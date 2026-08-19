// Socket.IO events for playback control (play/pause/seek), issuable by the
// primary host or any co-host (Phase 6.2B). All state math (canonical
// position, versioning, future scheduling target) lives in roomManager.js -
// this file only enforces "who is allowed to ask" and broadcasts the result
// via the existing room:update.
const roomManager = require('./roomManager');
const { requireController } = require('./socketUtils');

function registerPlaybackHandlers(io, socket) {
  socket.on('playback:play', (_payload, ack) => {
    const check = requireController(socket);
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
    const check = requireController(socket);
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
    const check = requireController(socket);
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

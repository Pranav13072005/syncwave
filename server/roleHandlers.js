// Socket.IO events for room-role management (Phase 6.2B): promoting a
// participant to co-host, demoting a co-host back to participant, and
// voluntarily transferring primary-host ownership. Deliberately PRIMARY-HOST-
// ONLY (requireHost, not requireController) - a co-host may control playback/
// queue but must never be able to manage other co-hosts or take over as
// primary host themselves.
const roomManager = require('./roomManager');
const { requireHost } = require('./socketUtils');

function registerRoleHandlers(io, socket) {
  socket.on('room:promoteCoHost', ({ targetSocketId } = {}, ack) => {
    const check = requireHost(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.promoteToCoHost(check.room.code, targetSocketId);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });

  socket.on('room:demoteCoHost', ({ targetSocketId } = {}, ack) => {
    const check = requireHost(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.demoteToParticipant(check.room.code, targetSocketId);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });

  socket.on('room:transferHost', ({ targetSocketId } = {}, ack) => {
    const check = requireHost(socket);
    if (check.error) {
      ack?.({ ok: false, error: check.error });
      return;
    }
    const result = roomManager.transferPrimaryHost(check.room.code, targetSocketId, socket.id);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    io.to(result.room.code).emit('room:update', roomManager.toPublicState(result.room));
    ack?.({ ok: true });
  });
}

module.exports = registerRoleHandlers;

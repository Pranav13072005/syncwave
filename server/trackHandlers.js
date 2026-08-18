// Socket.IO events for the upload-authorization handshake and per-device
// READY reporting. The actual file bytes travel over HTTP (server/uploadRoute.js,
// Multer) - this file only issues the upload token and records readiness.
const roomManager = require('./roomManager');
const uploadTokens = require('./uploadTokens');
const { getSocketRoomCode } = require('./socketUtils');

function registerTrackHandlers(io, socket) {
  socket.on('track:requestUploadToken', (_payload, ack) => {
    const roomCode = getSocketRoomCode(socket);
    const room = roomCode ? roomManager.getRoom(roomCode) : null;
    if (!room) {
      ack?.({ ok: false, error: 'NO_ROOM' });
      return;
    }
    if (room.hostId !== socket.id) {
      ack?.({ ok: false, error: 'NOT_HOST' });
      return;
    }
    const token = uploadTokens.createToken(roomCode, socket.id);
    ack?.({ ok: true, token });
  });

  socket.on('track:ready', ({ version } = {}, ack) => {
    const room = roomManager.setReady(socket.id, version);
    if (!room) {
      ack?.({ ok: false });
      return;
    }
    io.to(room.code).emit('room:update', roomManager.toPublicState(room));
    ack?.({ ok: true });
  });
}

module.exports = registerTrackHandlers;

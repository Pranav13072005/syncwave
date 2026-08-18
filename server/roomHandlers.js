// Socket.IO event wiring for room create/join/leave. Delegates all state
// logic to roomManager - this file only translates socket events <-> state
// and broadcasts updates to the room.
const roomManager = require('./roomManager');

function registerRoomHandlers(io, socket) {
  socket.on('room:create', ({ name } = {}, ack) => {
    const deviceName = (name || 'Device').toString().slice(0, 40);
    const room = roomManager.createRoom(socket.id, deviceName);
    socket.join(room.code);
    ack?.({ ok: true, state: roomManager.toPublicState(room) });
  });

  socket.on('room:join', ({ roomCode, name } = {}, ack) => {
    const deviceName = (name || 'Device').toString().slice(0, 40);
    const code = (roomCode || '').toString().toUpperCase().trim();
    const result = roomManager.joinRoom(code, socket.id, deviceName);
    if (result.error) {
      ack?.({ ok: false, error: result.error });
      return;
    }
    socket.join(code);
    ack?.({ ok: true, state: roomManager.toPublicState(result.room) });
    io.to(code).emit('room:update', roomManager.toPublicState(result.room));
  });

  socket.on('room:leave', (_payload, ack) => {
    const roomCode = getSocketRoomCode(socket);
    const room = roomManager.leaveRoom(socket.id);
    if (roomCode) socket.leave(roomCode);
    if (room) io.to(room.code).emit('room:update', roomManager.toPublicState(room));
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = roomManager.leaveRoom(socket.id);
    if (room) io.to(room.code).emit('room:update', roomManager.toPublicState(room));
  });
}

// socket.io v4 keeps a socket's own id plus any joined room names in socket.rooms.
function getSocketRoomCode(socket) {
  return Array.from(socket.rooms).find((r) => r !== socket.id) || null;
}

module.exports = registerRoomHandlers;

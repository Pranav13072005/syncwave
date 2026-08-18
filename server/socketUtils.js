// socket.io v4 keeps a socket's own id plus any joined room names in socket.rooms.
function getSocketRoomCode(socket) {
  return Array.from(socket.rooms).find((r) => r !== socket.id) || null;
}

module.exports = { getSocketRoomCode };

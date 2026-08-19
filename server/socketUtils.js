const roomManager = require('./roomManager');

// socket.io v4 keeps a socket's own id plus any joined room names in socket.rooms.
function getSocketRoomCode(socket) {
  return Array.from(socket.rooms).find((r) => r !== socket.id) || null;
}

// Shared host-authorization check for every host-only command handler
// (playback play/pause/seek, queue remove/reorder/next) - moved here from
// playbackHandlers.js (Phase 6.2A) so queueHandlers.js can reuse the exact
// same check/error shape rather than duplicating it.
function requireHost(socket) {
  const roomCode = getSocketRoomCode(socket);
  const room = roomCode ? roomManager.getRoom(roomCode) : null;
  if (!room) return { error: 'NO_ROOM' };
  if (room.hostId !== socket.id) return { error: 'NOT_HOST' };
  return { room };
}

module.exports = { getSocketRoomCode, requireHost };

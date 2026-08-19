const roomManager = require('./roomManager');

// socket.io v4 keeps a socket's own id plus any joined room names in socket.rooms.
function getSocketRoomCode(socket) {
  return Array.from(socket.rooms).find((r) => r !== socket.id) || null;
}

// Shared PRIMARY-HOST-only authorization check - used for role management
// (promote/demote/transfer), which a co-host may NOT perform (moved here
// from playbackHandlers.js in Phase 6.2A so queueHandlers.js could reuse it;
// Phase 6.2B keeps this the strict primary-only check and adds
// requireController below for the broader "primary OR co-host" case).
function requireHost(socket) {
  const roomCode = getSocketRoomCode(socket);
  const room = roomCode ? roomManager.getRoom(roomCode) : null;
  if (!room) return { error: 'NO_ROOM' };
  if (room.hostId !== socket.id) return { error: 'NOT_HOST' };
  return { room };
}

// Shared "primary host OR co-host" authorization check (Phase 6.2B) - used
// for playback control (play/pause/seek) and queue mutations (next/remove/
// reorder), which co-hosts are allowed to perform, unlike role management.
// Deliberately reuses the SAME 'NOT_HOST' error code as requireHost (not a
// new 'NOT_AUTHORIZED') so existing client error-message mapping and tests
// keep working unchanged - a plain participant is still, from the caller's
// perspective, simply not host-tier.
function requireController(socket) {
  const roomCode = getSocketRoomCode(socket);
  const room = roomCode ? roomManager.getRoom(roomCode) : null;
  if (!room) return { error: 'NO_ROOM' };
  if (room.hostId !== socket.id && !room.coHostIds.has(socket.id)) return { error: 'NOT_HOST' };
  return { room };
}

module.exports = { getSocketRoomCode, requireHost, requireController };

// In-memory room store. No database - rooms live only for the process
// lifetime, per MVP scope (no persistence required).
const rooms = new Map(); // roomCode -> { code, hostId, clients: Map<socketId, {id, name, isHost}> }

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const CODE_LENGTH = 5;

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(hostSocketId, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    clients: new Map([[hostSocketId, { id: hostSocketId, name: hostName, isHost: true }]]),
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(roomCode, socketId, name) {
  const room = rooms.get(roomCode);
  if (!room) return { error: 'ROOM_NOT_FOUND' };
  room.clients.set(socketId, { id: socketId, name, isHost: socketId === room.hostId });
  return { room };
}

// Removes a socket from whatever room it's in. If it was the host, the room
// is left hostless (null) rather than auto-promoting - see PROJECT_CONTEXT
// "Known issues": deliberate reassignment/pause policy is Phase 6 scope.
// Returns the affected room (possibly deleted if now empty), or null if the
// socket wasn't in any room.
function leaveRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.clients.has(socketId)) {
      room.clients.delete(socketId);
      if (room.hostId === socketId) room.hostId = null;
      if (room.clients.size === 0) {
        rooms.delete(room.code);
        return null;
      }
      return room;
    }
  }
  return null;
}

function getRoom(roomCode) {
  return rooms.get(roomCode) || null;
}

function toPublicState(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    clients: Array.from(room.clients.values()),
  };
}

module.exports = { createRoom, joinRoom, leaveRoom, getRoom, toPublicState };

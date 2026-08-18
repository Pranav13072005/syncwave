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
    track: null, // { version, originalName, mimeType, size, url, storedFilename, uploadedAt }
    readyDevices: new Set(), // socketIds that have decoded room.track at its current version
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
      room.readyDevices.delete(socketId);
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

// Finds whichever room a socket currently belongs to (used by handlers that
// only know the socket, not the room code).
function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.clients.has(socketId)) return room;
  }
  return null;
}

// Replaces the room's current track, bumping its version and clearing all
// READY state - clients must re-decode and re-confirm ready for the new
// track. Returns the previous track (if any) so its file can be cleaned up.
function setTrack(roomCode, meta) {
  const room = rooms.get(roomCode);
  if (!room) return null;
  const previousTrack = room.track;
  const version = previousTrack ? previousTrack.version + 1 : 1;
  room.track = { version, ...meta };
  room.readyDevices = new Set();
  return { room, previousTrack };
}

// Marks a socket as READY for a specific track version. Rejects (no-op) if
// the socket isn't in a room, there's no current track, or the version is
// stale - protects against a slow decode finishing after the track changed.
function setReady(socketId, version) {
  const room = findRoomBySocket(socketId);
  if (!room || !room.track || room.track.version !== version) return null;
  room.readyDevices.add(socketId);
  return room;
}

function toPublicState(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    track: room.track,
    clients: Array.from(room.clients.values()).map((c) => ({
      ...c,
      isReady: room.readyDevices.has(c.id),
    })),
  };
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  findRoomBySocket,
  setTrack,
  setReady,
  toPublicState,
};

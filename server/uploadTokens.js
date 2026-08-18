// Short-lived, single-use tokens proving a request came from the room's
// actual host. Needed because room state (including hostId) is broadcast to
// every client, so an HTTP upload endpoint can't just trust a client-claimed
// identity - the token is only ever issued to the socket that IS the host at
// issue time (checked via the live, unspoofable socket connection).
const crypto = require('crypto');

const tokens = new Map(); // token -> { roomCode, socketId, expiresAt }
const TOKEN_TTL_MS = 30_000;

function createToken(roomCode, socketId) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { roomCode, socketId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function consumeToken(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token); // single-use regardless of outcome
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

module.exports = { createToken, consumeToken };

// Handles clients reporting their own periodic drift measurement
// (client/src/driftMonitor.js). Mirrors clockHandlers.js exactly - stores
// the client-computed result for diagnostics and re-broadcasts room state.
// Never used to derive authoritative playback state.
const roomManager = require('./roomManager');

function registerDriftHandlers(io, socket) {
  socket.on('playback:driftReport', ({ driftMs, correctionCount } = {}, ack) => {
    const room = roomManager.updatePlaybackDiagnostics(socket.id, {
      driftMs: typeof driftMs === 'number' ? driftMs : null,
      correctionCount: typeof correctionCount === 'number' ? correctionCount : 0,
    });
    if (room) {
      io.to(room.code).emit('room:update', roomManager.toPublicState(room));
    }
    ack?.({ ok: !!room });
  });
}

module.exports = registerDriftHandlers;

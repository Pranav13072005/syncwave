// Handles clients reporting the result of their own robust clock-offset
// estimate (client/src/clockSync.js). The `clock:ping` primitive itself is
// registered in index.js (unchanged since Phase 0) - this file only stores
// the client-computed result for diagnostics and re-broadcasts room state.
const roomManager = require('./roomManager');

function registerClockHandlers(io, socket) {
  socket.on('clock:report', ({ rtt, offsetMs, status } = {}, ack) => {
    const room = roomManager.updateClientDiagnostics(socket.id, {
      rtt: typeof rtt === 'number' ? rtt : null,
      offsetMs: typeof offsetMs === 'number' ? offsetMs : null,
      status: status || 'unsynced',
    });
    if (room) {
      io.to(room.code).emit('room:update', roomManager.toPublicState(room));
    }
    ack?.({ ok: !!room });
  });
}

module.exports = registerClockHandlers;

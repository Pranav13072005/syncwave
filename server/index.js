// Phase 0 proof of concept server.
// Responsibilities kept deliberately minimal: serve the static PoC client,
// answer clock-offset ping/pong, and broadcast a single future scheduled-play
// event to all connected sockets. Rooms, auth, versioning, drift correction
// etc. are NOT implemented here yet - they arrive in later phases.
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const registerRoomHandlers = require('./roomHandlers');
const registerTrackHandlers = require('./trackHandlers');
const { createUploadRouter, UPLOAD_DIR } = require('./uploadRoute');

const PORT = process.env.PORT || 3001;
const SCHEDULE_LEAD_MS = 1000; // how far into the future we schedule play

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const server = http.createServer(app);
const io = new Server(server);
app.use('/api', createUploadRouter(io));

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${io.engine.clientsCount} connected)`);

  registerRoomHandlers(io, socket);
  registerTrackHandlers(io, socket);

  // Single-sample Cristian's-algorithm style clock offset probe.
  // Phase 3 replaces this with an 8-10 sample, low-RTT/median robust estimate.
  socket.on('clock:ping', (clientSendTime, ack) => {
    ack({ serverTime: Date.now(), clientSendTime });
  });

  // Any connected client can trigger the shared play - Phase 0 has no host
  // concept yet, that's introduced in Phase 1.
  socket.on('poc:requestPlay', () => {
    const targetServerTime = Date.now() + SCHEDULE_LEAD_MS;
    console.log(`[poc:requestPlay] from ${socket.id}, targetServerTime=${targetServerTime}`);
    io.emit('poc:scheduledPlay', { targetServerTime, startOffsetSec: 0 });
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id} (${io.engine.clientsCount} connected)`);
  });
});

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lanAddrs = Object.values(nets)
    .flat()
    .filter((n) => n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log(`SyncWave Phase 0 PoC server listening on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  lanAddrs.forEach((addr) => console.log(`  Network: http://${addr}:${PORT}  (use this on a second device)`));
});

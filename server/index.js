// Express + Socket.IO server. Serves the Phase 0 PoC client as static files
// (server/public/*, still fully functional and untouched) alongside the real
// app's room/track/clock/playback/drift handlers registered below.
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const registerRoomHandlers = require('./roomHandlers');
const registerTrackHandlers = require('./trackHandlers');
const registerClockHandlers = require('./clockHandlers');
const registerPlaybackHandlers = require('./playbackHandlers');
const registerDriftHandlers = require('./driftHandlers');
const registerQueueHandlers = require('./queueHandlers');
const registerRoleHandlers = require('./roleHandlers');
const roomManager = require('./roomManager');
const { createUploadRouter, UPLOAD_DIR } = require('./uploadRoute');

// Phase 6: when a room is finally deleted (its empty-room grace period
// expired), delete its uploaded track file too - roomManager.js itself
// deliberately has no filesystem knowledge. Phase 6.2A: also delete every
// queued file - a deleted room must not leak any file it was still holding
// a reference to, current or queued.
roomManager.onRoomDeleted((room) => {
  if (room.track?.storedFilename) {
    fs.unlink(path.join(UPLOAD_DIR, room.track.storedFilename), () => {});
  }
  for (const queuedTrack of room.queue) {
    if (queuedTrack.storedFilename) {
      fs.unlink(path.join(UPLOAD_DIR, queuedTrack.storedFilename), () => {});
    }
  }
});

const PORT = process.env.PORT || 3001;
const SCHEDULE_LEAD_MS = 1000; // how far into the future we schedule play

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const server = http.createServer(app);
const io = new Server(server);
app.use('/api', createUploadRouter(io));

// When a track naturally reaches its duration, roomManager.js's server-side
// end timer either pauses at the track's end (empty queue, Phase 6.1) or
// advances to the next queued track (Phase 6.2A) and calls this listener to
// broadcast the result - roomManager.js has no `io`/filesystem access
// itself. On an advance, the superseded track's file is cleaned up here too
// (mirrors uploadRoute.js's replace-track cleanup, just triggered internally
// by the timer instead of a new upload).
roomManager.onPlaybackCompleted((room, info) => {
  if (info?.previousTrack?.storedFilename) {
    fs.unlink(path.join(UPLOAD_DIR, info.previousTrack.storedFilename), () => {});
  }
  io.to(room.code).emit('room:update', roomManager.toPublicState(room));
});

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id} (${io.engine.clientsCount} connected)`);

  registerRoomHandlers(io, socket);
  registerTrackHandlers(io, socket);
  registerClockHandlers(io, socket);
  registerPlaybackHandlers(io, socket);
  registerDriftHandlers(io, socket);
  registerQueueHandlers(io, socket);
  registerRoleHandlers(io, socket);

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

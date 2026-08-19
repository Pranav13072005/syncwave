// POST /api/upload - accepts the current track's audio file. Gated by a
// short-lived token (see uploadTokens.js) rather than a client-claimed
// identity, since room state (hostId) is visible to every client.
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const express = require('express');
const roomManager = require('./roomManager');
const uploadTokens = require('./uploadTokens');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Phase 7 production-config cleanup: overridable via UPLOAD_MAX_FILE_SIZE_MB
// (e.g. a smaller limit for a constrained deployment), defaulting to the
// same 25MB every previous phase has used.
const MAX_FILE_SIZE_BYTES = (Number(process.env.UPLOAD_MAX_FILE_SIZE_MB) || 25) * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      cb(new Error('INVALID_FILE_TYPE'));
      return;
    }
    cb(null, true);
  },
});

function createUploadRouter(io) {
  const router = express.Router();

  router.post('/upload', (req, res) => {
    const consumed = uploadTokens.consumeToken(req.headers['x-upload-token']);
    if (!consumed) {
      res.status(403).json({ error: 'INVALID_TOKEN' });
      return;
    }
    // Re-check role status at consumption time, not just issue time: host/
    // co-host status can change (Phase 6 reassignment, Phase 6.2B promote/
    // demote/transfer) between when a token was issued and when the upload
    // actually completes. A token issued to a former host or a since-demoted
    // co-host must not still grant upload access.
    const currentRoom = roomManager.getRoom(consumed.roomCode);
    if (!currentRoom || (currentRoom.hostId !== consumed.socketId && !currentRoom.coHostIds.has(consumed.socketId))) {
      res.status(403).json({ error: 'INVALID_TOKEN' });
      return;
    }

    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'FILE_TOO_LARGE' });
        } else if (err.message === 'INVALID_FILE_TYPE') {
          res.status(400).json({ error: 'INVALID_FILE_TYPE' });
        } else {
          res.status(400).json({ error: 'UPLOAD_FAILED' });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'NO_FILE' });
        return;
      }

      const meta = {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        storedFilename: req.file.filename,
        url: `/uploads/${req.file.filename}`,
        uploadedAt: Date.now(),
      };

      // Re-fetch room state right here (not the `currentRoom` snapshot taken
      // before the multer disk write, which is async and could race a second
      // upload) to decide the destination: no current track yet -> this
      // upload becomes current (Phase 2 behavior, unchanged); a current
      // track already exists -> append to the queue instead (Phase 6.2A) -
      // uploads no longer replace a track that's already playing.
      const roomNow = roomManager.getRoom(consumed.roomCode);
      if (!roomNow) {
        fs.unlink(req.file.path, () => {});
        res.status(404).json({ error: 'ROOM_NOT_FOUND' });
        return;
      }

      const result = roomNow.track
        ? roomManager.addToQueue(consumed.roomCode, meta)
        : roomManager.setTrack(consumed.roomCode, meta);

      if (result.previousTrack?.storedFilename) {
        fs.unlink(path.join(UPLOAD_DIR, result.previousTrack.storedFilename), () => {});
      }

      io.to(consumed.roomCode).emit('room:update', roomManager.toPublicState(result.room));
      res.json({ ok: true, track: result.room.track, queuedTrack: result.queuedTrack });
    });
  });

  return router;
}

module.exports = { createUploadRouter, UPLOAD_DIR, MAX_FILE_SIZE_BYTES };

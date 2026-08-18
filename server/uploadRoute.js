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

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB - generous for MP3/WAV demo tracks
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

      const result = roomManager.setTrack(consumed.roomCode, {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        storedFilename: req.file.filename,
        url: `/uploads/${req.file.filename}`,
        uploadedAt: Date.now(),
      });

      if (!result) {
        fs.unlink(req.file.path, () => {});
        res.status(404).json({ error: 'ROOM_NOT_FOUND' });
        return;
      }

      if (result.previousTrack?.storedFilename) {
        fs.unlink(path.join(UPLOAD_DIR, result.previousTrack.storedFilename), () => {});
      }

      io.to(consumed.roomCode).emit('room:update', roomManager.toPublicState(result.room));
      res.json({ ok: true, track: result.room.track });
    });
  });

  return router;
}

module.exports = { createUploadRouter, UPLOAD_DIR, MAX_FILE_SIZE_BYTES };

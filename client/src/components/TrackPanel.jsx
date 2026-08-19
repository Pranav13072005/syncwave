import { useState } from 'react';
import { socket } from '../socket';

const UPLOAD_ERROR_MESSAGES = {
  NOT_HOST: 'Only the host can upload a track.',
  NO_ROOM: 'You are not in a room.',
  INVALID_FILE_TYPE: 'Only MP3 and WAV files are supported.',
  FILE_TOO_LARGE: 'File is too large (max 25MB).',
  INVALID_TOKEN: 'Upload session expired - please try again.',
  NO_FILE: 'No file was received.',
  ROOM_NOT_FOUND: 'Room no longer exists.',
};

export default function TrackPanel({ isHost, track }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    setError('');
    setUploading(true);
    try {
      const tokenRes = await new Promise((resolve) => {
        socket.emit('track:requestUploadToken', {}, resolve);
      });
      if (!tokenRes?.ok) {
        throw new Error(UPLOAD_ERROR_MESSAGES[tokenRes?.error] || 'Could not start upload.');
      }

      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-upload-token': tokenRes.token },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(UPLOAD_ERROR_MESSAGES[data.error] || 'Upload failed.');
      }
      // Success - the server broadcasts room:update with the new track to everyone, including us.
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="track-panel">
      <h2>Track</h2>
      {track ? (
        <p>
          Now playing: <strong>{track.originalName}</strong> ({(track.size / (1024 * 1024)).toFixed(1)} MB)
        </p>
      ) : (
        <p>No track uploaded yet.</p>
      )}

      {isHost && (
        <label className={`upload-control${uploading ? ' disabled' : ''}`}>
          {uploading ? 'Uploading…' : track ? 'Add to Queue' : 'Upload Track'}
          <input
            type="file"
            accept=".mp3,.wav,audio/mpeg,audio/wav"
            onChange={handleFileChange}
            disabled={uploading}
            hidden
          />
        </label>
      )}
      {!isHost && !track && <p className="hint">Waiting for the host to upload a track.</p>}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

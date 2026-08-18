import { useEffect, useState } from 'react';
import { socket } from '../socket';
import { getClockOffsetMs } from '../clockSync';

const ERROR_MESSAGES = {
  NOT_HOST: 'Only the host can control playback.',
  NO_ROOM: 'You are not in a room.',
  NO_TRACK: 'Upload a track before starting playback.',
  INVALID_SEEK_POSITION: 'Enter a valid seek position (0 or greater).',
  SEEK_OUT_OF_RANGE: 'Seek position is beyond the track length.',
};

// Extrapolates a live display position from the last authoritative playback
// state - for the UI only, never fed back into audio scheduling. Uses the
// same math as the server's getCanonicalPosition, but with the client's own
// offset-adjusted notion of "server time now".
function estimateDisplayPosition(playback) {
  if (playback.status !== 'playing' || playback.anchorServerTime == null) {
    return playback.positionSec;
  }
  const offsetMs = getClockOffsetMs() ?? 0;
  const estimatedServerNow = Date.now() + offsetMs;
  const elapsedSec = Math.max(0, (estimatedServerNow - playback.anchorServerTime) / 1000);
  return playback.positionSec + elapsedSec;
}

export default function PlaybackControls({ isHost, playback, trackDurationSec }) {
  const [seekValue, setSeekValue] = useState('');
  const [error, setError] = useState('');
  const [, forceTick] = useState(0);

  // Live-ish position readout while playing; purely cosmetic, doesn't affect scheduling.
  useEffect(() => {
    if (playback.status !== 'playing') return;
    const id = setInterval(() => forceTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [playback.status, playback.version]);

  function send(event, payload) {
    setError('');
    socket.emit(event, payload, (ack) => {
      if (!ack?.ok) {
        setError(ERROR_MESSAGES[ack?.error] || 'Command failed.');
      }
    });
  }

  function handleSeek() {
    const positionSec = parseFloat(seekValue);
    if (Number.isNaN(positionSec)) {
      setError('Enter a valid seek position.');
      return;
    }
    send('playback:seek', { positionSec });
  }

  const displayPosition = estimateDisplayPosition(playback);
  const statusLabel = playback.status === 'playing' ? 'Playing' : 'Paused';

  return (
    <div className="playback-panel">
      <h2>Playback</h2>
      <p>
        Status: <strong>{statusLabel}</strong> at ~{displayPosition.toFixed(1)}s
        {trackDurationSec != null && ` / ${trackDurationSec.toFixed(1)}s`}
      </p>

      {isHost ? (
        <div className="playback-controls">
          <button onClick={() => send('playback:play', {})}>Play</button>
          <button onClick={() => send('playback:pause', {})}>Pause</button>
          <input
            type="number"
            min="0"
            step="0.1"
            placeholder="Seek to (s)"
            value={seekValue}
            onChange={(e) => setSeekValue(e.target.value)}
          />
          <button onClick={handleSeek}>Seek</button>
        </div>
      ) : (
        <p className="hint">Only the host can control playback.</p>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { socket } from '../socket';
import { unlockAudioContext, decodeTrackFromUrl } from '../audioEngine';
import DeviceList from './DeviceList';
import TrackPanel from './TrackPanel';

const STATUS_LABELS = {
  idle: 'Waiting for track',
  downloading: 'Downloading track…',
  decoding: 'Decoding audio…',
  ready: 'READY',
  error: 'Error',
};

export default function Room({ initialState, onLeave }) {
  const [state, setState] = useState(initialState);
  const [connected, setConnected] = useState(socket.connected);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [decodeStatus, setDecodeStatus] = useState('idle');
  const [decodeError, setDecodeError] = useState(null);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    function handleUpdate(newState) {
      setState(newState);
    }
    function handleConnect() {
      setConnected(true);
    }
    function handleDisconnect() {
      setConnected(false);
    }

    socket.on('room:update', handleUpdate);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('room:update', handleUpdate);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, []);

  // Downloads + decodes the current track whenever it changes (new upload,
  // or a track that already existed when audio was enabled). A stale
  // in-flight decode is ignored if the track changes again before it
  // finishes, and READY is only reported for the version we actually decoded.
  useEffect(() => {
    if (!audioEnabled || !state.track) return;
    const targetVersion = state.track.version;
    let cancelled = false;
    setDecodeError(null);

    decodeTrackFromUrl(state.track.url, { onStatus: (s) => !cancelled && setDecodeStatus(s) })
      .then(() => {
        if (cancelled) return;
        setDecodeStatus('ready');
        socket.emit('track:ready', { version: targetVersion });
      })
      .catch((err) => {
        if (cancelled) return;
        setDecodeStatus('error');
        setDecodeError(err.message || 'Failed to load audio');
      });

    return () => {
      cancelled = true;
    };
  }, [audioEnabled, state.track?.version, state.track?.url, retryTick]);

  async function handleEnableAudio() {
    try {
      await unlockAudioContext();
      setAudioEnabled(true);
    } catch (err) {
      setDecodeError(`Could not enable audio: ${err.message}`);
      setDecodeStatus('error');
    }
  }

  function handleLeave() {
    socket.emit('room:leave', {}, () => {
      onLeave();
    });
  }

  const isHost = state.hostId === socket.id;

  return (
    <div className="room">
      <header className="room-header">
        <div>
          <span className="conn-dot" data-connected={connected} />
          {connected ? 'Connected' : 'Disconnected'}
        </div>
        <button onClick={handleLeave}>Leave Room</button>
      </header>

      <h1>
        Room <span className="room-code">{state.roomCode}</span>
      </h1>
      {!state.hostId && <p className="warning">No host in this room right now.</p>}
      {isHost && <p className="host-tag">You are the host.</p>}

      <TrackPanel isHost={isHost} track={state.track} />

      <div className="ready-panel">
        <h2>Audio</h2>
        {!audioEnabled ? (
          <button onClick={handleEnableAudio}>Enable Audio</button>
        ) : (
          <p>
            Status: <strong>{STATUS_LABELS[decodeStatus] || decodeStatus}</strong>
          </p>
        )}
        {decodeStatus === 'error' && (
          <>
            <p className="error">{decodeError}</p>
            <button onClick={() => setRetryTick((t) => t + 1)}>Retry</button>
          </>
        )}
      </div>

      <h2>Connected devices ({state.clients.length})</h2>
      <DeviceList clients={state.clients} mySocketId={socket.id} />
    </div>
  );
}

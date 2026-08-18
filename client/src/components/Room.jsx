import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket';
import { unlockAudioContext, decodeTrackFromUrl } from '../audioEngine';
import { schedulePlay, schedulePause, resetPlaybackEngine, isNewerPlaybackVersion, getActualPositionSec } from '../playbackEngine';
import { getClockOffsetMs } from '../clockSync';
import {
  computeExpectedPositionSec,
  computeDriftMs,
  canMeasureDrift,
  createInitialDriftState,
  evaluateDriftSample,
  DEFAULT_MEASURE_INTERVAL_MS,
  DEFAULT_CORRECTION_LEAD_MS,
} from '../driftMonitor';
import DeviceList from './DeviceList';
import TrackPanel from './TrackPanel';
import Diagnostics from './Diagnostics';
import PlaybackControls from './PlaybackControls';

const STATUS_LABELS = {
  idle: 'Waiting for track',
  downloading: 'Downloading track…',
  decoding: 'Decoding audio…',
  ready: 'READY',
  error: 'Error',
};

const DEFAULT_PLAYBACK = { status: 'paused', positionSec: 0, anchorServerTime: null, version: -1, trackVersion: null };

export default function Room({ initialState, onLeave }) {
  const [state, setState] = useState(initialState);
  const [connected, setConnected] = useState(socket.connected);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [decodeStatus, setDecodeStatus] = useState('idle');
  const [decodeError, setDecodeError] = useState(null);
  const [retryTick, setRetryTick] = useState(0);
  const [decodedVersion, setDecodedVersion] = useState(null); // triggers a re-check when decode catches up to a pending command
  const [driftMs, setDriftMs] = useState(null);
  const [correctionCount, setCorrectionCount] = useState(0);
  const bufferRef = useRef({ version: null, buffer: null }); // decoded AudioBuffer for the current track version
  const appliedPlaybackVersionRef = useRef(-1); // last playback.version actually scheduled
  const driftStateRef = useRef(createInitialDriftState()); // consecutiveViolations/cooldown - reset whenever a new authoritative command arrives
  const driftTrackVersionRef = useRef(null); // which track the correction count is scoped to

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

  // Stop any scheduled/playing audio when leaving this room entirely.
  useEffect(() => {
    return () => resetPlaybackEngine();
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
      .then((buffer) => {
        if (cancelled) return;
        bufferRef.current = { version: targetVersion, buffer };
        setDecodedVersion(targetVersion);
        setDecodeStatus('ready');
        socket.emit('track:ready', { version: targetVersion, durationSec: buffer.duration });
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

  // Applies the authoritative playback state to the local Web Audio engine.
  // Ignores stale/duplicate versions. If this device hasn't decoded the
  // track version the command applies to yet, the command is left pending
  // (NOT marked applied) rather than dropped - once decode catches up
  // (decodedVersion changes), this effect re-runs and retries it. This
  // matters even outside late-join: a host can click Play before their own
  // device finishes decoding a just-uploaded track.
  useEffect(() => {
    const pb = state.playback;
    if (!pb || !isNewerPlaybackVersion(pb.version, appliedPlaybackVersionRef.current)) return;

    if (pb.status === 'paused') {
      appliedPlaybackVersionRef.current = pb.version;
      schedulePause(pb.anchorServerTime, getClockOffsetMs());
      return;
    }

    const decoded = bufferRef.current;
    if (!decoded.buffer || decoded.version !== pb.trackVersion) {
      console.warn(`Playback pending: track v${pb.trackVersion} not decoded on this device yet`);
      return; // not consumed - retried once decodedVersion catches up
    }
    appliedPlaybackVersionRef.current = pb.version;
    schedulePlay(decoded.buffer, pb.positionSec, pb.anchorServerTime, getClockOffsetMs());
  }, [state.playback?.version, state.playback?.status, state.playback?.trackVersion, decodedVersion]);

  // Periodic drift measurement + threshold-based correction. Does nothing at
  // all while paused (no interval is even created). Whenever a new
  // authoritative command arrives (playback.version changes), the violation
  // streak/cooldown are reset - a stale streak from a superseded command must
  // never trigger a correction against the new one. The correction counter is
  // scoped to the current track (reset on track change), not to every
  // individual command, so normal play/pause/seek don't zero out the stat.
  useEffect(() => {
    const pb = state.playback;
    if (!pb || pb.status !== 'playing') {
      setDriftMs(null);
      return;
    }

    driftStateRef.current = { ...driftStateRef.current, consecutiveViolations: 0, cooldownUntilMs: null };
    if (driftTrackVersionRef.current !== pb.trackVersion) {
      driftTrackVersionRef.current = pb.trackVersion;
      driftStateRef.current = createInitialDriftState();
      setCorrectionCount(0);
    }

    const intervalId = setInterval(() => {
      const decoded = bufferRef.current;
      const decodedTrackVersion = decoded.buffer ? decoded.version : null;
      if (!canMeasureDrift(pb, decodedTrackVersion)) return;

      const actualPositionSec = getActualPositionSec();
      if (actualPositionSec === null) return; // nothing actually scheduled/playing locally yet

      const offsetMs = getClockOffsetMs() ?? 0;
      const nowServerMs = Date.now() + offsetMs;
      const expectedPositionSec = computeExpectedPositionSec(pb, nowServerMs);
      const drift = computeDriftMs(actualPositionSec, expectedPositionSec);
      setDriftMs(drift);

      const nextState = evaluateDriftSample(driftStateRef.current, drift, Date.now());
      driftStateRef.current = nextState;
      setCorrectionCount(nextState.correctionCount);

      socket.emit('playback:driftReport', { driftMs: drift, correctionCount: nextState.correctionCount });

      if (nextState.didCorrect) {
        const correctionAnchorServerTime = nowServerMs + DEFAULT_CORRECTION_LEAD_MS;
        const correctedPositionSec = computeExpectedPositionSec(pb, correctionAnchorServerTime);
        schedulePlay(decoded.buffer, correctedPositionSec, correctionAnchorServerTime, offsetMs);
      }
    }, DEFAULT_MEASURE_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [state.playback?.version, state.playback?.status, state.playback?.trackVersion]);

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
    resetPlaybackEngine();
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

      <PlaybackControls
        isHost={isHost}
        playback={state.playback || DEFAULT_PLAYBACK}
        trackDurationSec={state.track?.durationSec ?? null}
      />

      <Diagnostics driftMs={driftMs} correctionCount={correctionCount} />

      <h2>Connected devices ({state.clients.length})</h2>
      <DeviceList clients={state.clients} mySocketId={socket.id} />
    </div>
  );
}

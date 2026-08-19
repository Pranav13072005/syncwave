import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket';
import { unlockAudioContext, decodeTrackFromUrl } from '../audioEngine';
import { schedulePlay, schedulePause, resetPlaybackEngine, getActualPositionSec } from '../playbackEngine';
import { getClockOffsetMs, getLastSyncStatus, onClockSyncResult } from '../clockSync';
import { arePrerequisitesMet, createInitialRecoveryState, receivePlaybackState, tryConsumePending } from '../recoveryState';
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

  // Phase 6 recovery prerequisites. All four must hold before any
  // synchronized playback is scheduled - see recoveryState.js.
  const [roomJoined, setRoomJoined] = useState(true); // true already: Room only mounts after Landing's successful join
  const [hasLatestState, setHasLatestState] = useState(true); // initialState IS the latest state at mount
  const [clockSynced, setClockSynced] = useState(getLastSyncStatus() === 'synced');

  const bufferRef = useRef({ version: null, buffer: null }); // decoded AudioBuffer for the current track version
  const recoveryStateRef = useRef(createInitialRecoveryState());
  const driftStateRef = useRef(createInitialDriftState()); // consecutiveViolations/cooldown - reset whenever a new authoritative command arrives
  const driftTrackVersionRef = useRef(null); // which track the correction count is scoped to
  const roomCodeRef = useRef(initialState.roomCode); // remembered for reconnect rejoin - room code never changes for this session
  const myNameRef = useRef(initialState.clients.find((c) => c.id === socket.id)?.name || 'Device');
  const rejoinInFlightRef = useRef(false);

  // Seed the recovery machinery with the state we already have at mount.
  useEffect(() => {
    recoveryStateRef.current = receivePlaybackState(recoveryStateRef.current, initialState.playback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleUpdate(newState) {
      setState(newState);
      recoveryStateRef.current = receivePlaybackState(recoveryStateRef.current, newState.playback);
      setHasLatestState(true);
    }
    function handleConnect() {
      setConnected(true);
    }
    function handleDisconnect() {
      setConnected(false);
      // We can no longer be confident our local view is current - recovery
      // prerequisites drop until a fresh rejoin + re-sync confirm otherwise.
      setRoomJoined(false);
      setHasLatestState(false);
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

  // Reconnect recovery: Socket.IO hands us a brand-new socket.id on
  // reconnect and does not auto-rejoin rooms, so we rejoin explicitly using
  // the room code/name remembered from this session. Only once the rejoin
  // ack succeeds do roomJoined/hasLatestState become true again; clockSynced
  // is also dropped here so a stale pre-reconnect offset can't be relied on -
  // Diagnostics.jsx already triggers a fresh sync on this same 'reconnect'
  // event, and our onClockSyncResult subscription (below) picks up its result.
  useEffect(() => {
    function handleReconnect() {
      if (rejoinInFlightRef.current) return; // guard against overlapping rejoin attempts
      rejoinInFlightRef.current = true;
      setRoomJoined(false);
      setHasLatestState(false);
      setClockSynced(false);
      socket.emit('room:join', { roomCode: roomCodeRef.current, name: myNameRef.current }, (ack) => {
        rejoinInFlightRef.current = false;
        if (!ack?.ok) {
          console.warn('Failed to rejoin room after reconnect:', ack?.error);
          onLeave();
          return;
        }
        setState(ack.state);
        recoveryStateRef.current = receivePlaybackState(recoveryStateRef.current, ack.state.playback);
        setRoomJoined(true);
        setHasLatestState(true);
      });
    }

    socket.io.on('reconnect', handleReconnect);
    return () => {
      socket.io.off('reconnect', handleReconnect);
    };
  }, [onLeave]);

  // Reacts to clock-sync completion (triggered by Diagnostics.jsx on mount
  // and on reconnect) without duplicating that trigger here.
  useEffect(() => {
    return onClockSyncResult((result) => {
      setClockSynced(result.status === 'synced');
    });
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

  // Prerequisite-driven recovery apply: room joined + latest state received +
  // current track decoded + clock synchronized must ALL hold before anything
  // is scheduled. Covers late join (prerequisites start unmet, become met one
  // by one) and reconnect (explicitly reset, then re-earned) via the exact
  // same path - no parallel mechanism. Only the newest pending state is ever
  // applied (recoveryState.js never queues). Reuses the same
  // schedulePlay/schedulePause Phase 4 already established; a paused state is
  // adopted (position/status shown) without ever calling schedulePlay.
  useEffect(() => {
    const trackDecoded = state.track == null || decodedVersion === state.track.version;
    const { nextState, toApply } = tryConsumePending(recoveryStateRef.current, {
      roomJoined,
      hasLatestState,
      trackDecoded,
      clockSynced,
    });
    recoveryStateRef.current = nextState;
    if (!toApply) return;

    if (toApply.status === 'paused') {
      schedulePause(toApply.anchorServerTime, getClockOffsetMs());
      return;
    }

    const decoded = bufferRef.current;
    if (!decoded.buffer || decoded.version !== toApply.trackVersion) {
      // Shouldn't normally happen given trackDecoded already gated this -
      // stay defensive rather than schedule the wrong audio.
      console.warn(`Playback pending: track v${toApply.trackVersion} not decoded on this device yet`);
      return;
    }
    schedulePlay(decoded.buffer, toApply.positionSec, toApply.anchorServerTime, getClockOffsetMs());
  }, [roomJoined, hasLatestState, clockSynced, decodedVersion, state.track?.version, state.playback?.version]);

  // Periodic drift measurement + threshold-based correction. Does nothing at
  // all while paused (no interval is even created), and canMeasureDrift also
  // refuses to run without a genuinely completed clock sync (no 0ms
  // fallback - see driftMonitor.js). Whenever a new authoritative command
  // arrives (playback.version changes) or clock sync status changes, the
  // violation streak/cooldown are reset - a stale streak must never trigger
  // a correction against a superseded command or an unverified clock. The
  // correction counter is scoped to the current track (reset on track
  // change), not to every individual command.
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
      if (!canMeasureDrift(pb, decodedTrackVersion, clockSynced)) return;

      const actualPositionSec = getActualPositionSec();
      if (actualPositionSec === null) return; // nothing actually scheduled/playing locally yet

      const offsetMs = getClockOffsetMs(); // non-null here: canMeasureDrift's clockSynced check already gated this
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
  }, [state.playback?.version, state.playback?.status, state.playback?.trackVersion, clockSynced]);

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
  const recoveryReady = arePrerequisitesMet({
    roomJoined,
    hasLatestState,
    trackDecoded: state.track == null || decodedVersion === state.track.version,
    clockSynced,
  });

  return (
    <div className="room">
      <header className="room-header">
        <div>
          <span className="conn-dot" data-connected={connected} />
          {connected ? 'Connected' : 'Disconnected'}
          {!recoveryReady && connected && <span className="hint"> — synchronizing…</span>}
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

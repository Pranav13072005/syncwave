import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket';
import { unlockAudioContext, decodeTrackFromUrl } from '../audioEngine';
import { schedulePlay, schedulePause, resetPlaybackEngine, getActualPositionSec, getCurrentTrackVersion } from '../playbackEngine';
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
import QueuePanel from './QueuePanel';
import Diagnostics from './Diagnostics';
import PlaybackControls from './PlaybackControls';
import LocalSettings from './LocalSettings';
import InvitePanel from './InvitePanel';
import BenchmarkPanel from './BenchmarkPanel';
import { recordDriftSampleGlobal, recordCorrectionGlobal, recordJoinRecoveryGlobal, recordReconnectRecoveryGlobal } from '../benchmark';

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
  const nextBufferRef = useRef({ trackId: null, buffer: null }); // decoded AudioBuffer for the immediate-next queued track (queue[0]), preloaded ahead of time
  const recoveryStateRef = useRef(createInitialRecoveryState());
  const driftStateRef = useRef(createInitialDriftState()); // consecutiveViolations/cooldown - reset whenever a new authoritative command arrives
  const driftTrackVersionRef = useRef(null); // which track the correction count is scoped to
  const roomCodeRef = useRef(initialState.roomCode); // remembered for reconnect rejoin - room code never changes for this session
  const myNameRef = useRef(initialState.clients.find((c) => c.id === socket.id)?.name || 'Device');
  const rejoinInFlightRef = useRef(false);
  // Phase 7 benchmark facility - see benchmark.js for the exact measurement
  // boundaries. mountTimeRef anchors join-recovery-time; reconnectStartTimeRef
  // anchors reconnect-recovery-time (null except while a reconnect recovery
  // is in progress); joinRecoveryRecordedRef ensures only the first-ever
  // recovery completion counts as "join" (later ones close a reconnect
  // window instead).
  const mountTimeRef = useRef(typeof performance !== 'undefined' ? performance.now() : Date.now());
  const reconnectStartTimeRef = useRef(null);
  const joinRecoveryRecordedRef = useRef(false);
  // Phase 6.2A.1: the last playback.version actually fed into recoveryState.js.
  // A membership-only room:update (someone else joining/leaving) still
  // broadcasts the full state, but its `playback` is content-identical to
  // what we already have - skipping receivePlaybackState in that case avoids
  // marking a (redundant) pending entry and re-evaluating recovery for no
  // reason, so an already-settled device is never disturbed by unrelated
  // membership churn. tryConsumePending's own version check would have
  // discarded a redundant entry anyway, so this is a perf/no-op-avoidance
  // guard, not a correctness fix - genuinely newer playback always compares
  // as different and still flows through normally.
  const lastSeenPlaybackVersionRef = useRef(initialState.playback?.version ?? -1);

  // Seed the recovery machinery with the state we already have at mount.
  useEffect(() => {
    recoveryStateRef.current = receivePlaybackState(recoveryStateRef.current, initialState.playback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleUpdate(newState) {
      setState(newState);
      const incomingVersion = newState.playback?.version ?? -1;
      if (incomingVersion !== lastSeenPlaybackVersionRef.current) {
        lastSeenPlaybackVersionRef.current = incomingVersion;
        recoveryStateRef.current = receivePlaybackState(recoveryStateRef.current, newState.playback);
      }
      setHasLatestState(true);
    }
    function handleConnect() {
      setConnected(true);
    }
    function handleDisconnect() {
      setConnected(false);
      // We can no longer be confident our local view is current - recovery
      // prerequisites drop until a fresh rejoin + re-sync confirm otherwise
      // (this also blocks drift correction, gated on clockSynced).
      setRoomJoined(false);
      setHasLatestState(false);
      setClockSynced(false);
      // Stop local audio immediately - do NOT touch authoritative room state
      // or broadcast a pause; this device is simply isolating itself.
      // Decoded buffer is untouched (bufferRef), so reconnect can resume
      // without re-decoding.
      resetPlaybackEngine();
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
      reconnectStartTimeRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
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
        // Unlike the membership-only guard in handleUpdate above, a reconnect
        // ack is always processed unconditionally - the whole session context
        // (clockSynced etc.) was just reset, so even a version-identical
        // playback snapshot must be re-evaluated against fresh prerequisites.
        lastSeenPlaybackVersionRef.current = ack.state.playback?.version ?? -1;
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

  // The browser's own network-loss signal often fires faster than Socket.IO
  // notices (which waits out a ping/pong timeout), so it's used here purely
  // to react sooner with the same "stop local audio" action as the socket
  // disconnect handler above. It does NOT touch room membership/prerequisite
  // state - Socket.IO's own connect/disconnect/reconnect events remain the
  // sole authority for that, per the "keep server state authoritative"
  // requirement. Calling resetPlaybackEngine() twice in quick succession
  // (once here, once from the socket 'disconnect' that typically follows) is
  // harmless - it's a no-op once nothing is playing.
  useEffect(() => {
    function handleOffline() {
      resetPlaybackEngine();
    }
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);

  // Downloads + decodes the current track whenever it changes (new upload,
  // or a track that already existed when audio was enabled). A stale
  // in-flight decode is ignored if the track changes again before it
  // finishes, and READY is only reported for the version we actually decoded.
  useEffect(() => {
    if (!audioEnabled || !state.track) return;
    const targetVersion = state.track.version;
    const targetTrackId = state.track.trackId;
    let cancelled = false;
    setDecodeError(null);

    // This exact file may already have been decoded ahead of time as the
    // queue's next-track preload candidate (see the preload effect below) -
    // if so, promote it instead of re-downloading/re-decoding what's already
    // sitting in memory. Only trusted when the trackId matches EXACTLY (the
    // same stale-identity protection the server applies to next-track
    // readiness reports) - a mismatch just falls through to a normal decode.
    if (nextBufferRef.current.trackId === targetTrackId && nextBufferRef.current.buffer) {
      const promotedBuffer = nextBufferRef.current.buffer;
      bufferRef.current = { version: targetVersion, buffer: promotedBuffer };
      nextBufferRef.current = { trackId: null, buffer: null };
      setDecodedVersion(targetVersion);
      setDecodeStatus('ready');
      socket.emit('track:ready', { version: targetVersion, durationSec: promotedBuffer.duration });
      return;
    }

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

  // Preloads/decodes ONLY the immediate-next queued track (queue[0]), never
  // the whole queue - keeps memory use bounded while still making the next
  // transition fast. Independent of the recovery prerequisites (it's a
  // background optimization, not something synchronized playback depends
  // on) and declared after the current-track decode effect above so a
  // slow/contended connection prioritizes downloading the CURRENT track
  // first, per the spec's "current-track recovery must take priority over
  // next-track preload". A preload failure is non-fatal - this device simply
  // won't be next-ready and will fall back to the normal decode-then-recover
  // path once the track actually becomes current (same as any late-decoding
  // device - see requirement 10 in the Phase 6.2A brief).
  useEffect(() => {
    const nextTrack = state.queue?.[0] || null;
    if (!audioEnabled || !nextTrack) return;
    const targetTrackId = nextTrack.trackId;
    if (nextBufferRef.current.trackId === targetTrackId) return; // already preloaded (or in flight) for this exact track
    let cancelled = false;

    decodeTrackFromUrl(nextTrack.url)
      .then((buffer) => {
        if (cancelled) return;
        nextBufferRef.current = { trackId: targetTrackId, buffer };
        socket.emit('queue:trackReady', { trackId: targetTrackId, durationSec: buffer.duration });
      })
      .catch((err) => {
        console.warn(`Next-track preload failed for track ${targetTrackId}:`, err.message || err);
      });

    return () => {
      cancelled = true;
    };
  }, [audioEnabled, state.queue?.[0]?.trackId]);

  // Prerequisite-driven recovery apply: room joined + latest state received +
  // current track decoded + clock synchronized must ALL hold before anything
  // is scheduled. Covers late join (prerequisites start unmet, become met one
  // by one) and reconnect (explicitly reset, then re-earned) via the exact
  // same path - no parallel mechanism. Only the newest pending state is ever
  // applied (recoveryState.js never queues). Reuses the same
  // schedulePlay/schedulePause Phase 4 already established; a paused state is
  // adopted (position/status shown) without ever calling schedulePlay.
  //
  // For a 'playing' state, tryConsumePending recomputes the actual position
  // to start from (via computeScheduledPlayingState) instead of using the
  // command's original positionSec/anchorServerTime as-is - by the time a
  // late joiner or a recovering client is ready, that snapshot can be
  // arbitrarily old, so passing it straight through would start audio from
  // the WRONG position (this was the late-join-starts-at-0 bug: it always
  // schedules relative to "now", but was using a stale offset for how far
  // into the track that "now" actually corresponds to).
  useEffect(() => {
    const trackDecoded = state.track == null || decodedVersion === state.track.version;
    const offsetMs = getClockOffsetMs();
    // Only meaningful once clockSynced is true, which arePrerequisitesMet
    // already requires before toApply can be non-null - never relied upon
    // as a 0ms fallback for actual scheduling.
    const nowServerTimeMs = offsetMs !== null ? Date.now() + offsetMs : null;

    const { nextState, toApply } = tryConsumePending(
      recoveryStateRef.current,
      { roomJoined, hasLatestState, trackDecoded, clockSynced },
      { nowServerTimeMs, durationSec: state.track?.durationSec ?? null },
    );
    recoveryStateRef.current = nextState;
    if (!toApply) return;

    // Phase 7 benchmark facility: this is the moment recovery successfully
    // produced a scheduling instruction - "valid synchronized playback"
    // whether toApply is playing OR paused (see benchmark.js's documented
    // measurement boundary). The first one ever counts as join recovery; one
    // during an active reconnect window also closes that reconnect sample.
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!joinRecoveryRecordedRef.current) {
      joinRecoveryRecordedRef.current = true;
      recordJoinRecoveryGlobal(nowPerf - mountTimeRef.current);
    }
    if (reconnectStartTimeRef.current !== null) {
      recordReconnectRecoveryGlobal(nowPerf - reconnectStartTimeRef.current);
      reconnectStartTimeRef.current = null;
    }

    if (toApply.status === 'paused') {
      schedulePause(toApply.anchorServerTime, offsetMs);
      return;
    }

    const decoded = bufferRef.current;
    if (!decoded.buffer || decoded.version !== toApply.trackVersion) {
      // Shouldn't normally happen given trackDecoded already gated this -
      // stay defensive rather than schedule the wrong audio. This device
      // will pick the pending state back up once decode catches up
      // (decodedVersion changing re-triggers this effect); any stale source
      // it's still playing meanwhile is retired by the effect below,
      // independently of this decode-gated "start the new one" path.
      console.warn(`Playback pending: track v${toApply.trackVersion} not decoded on this device yet`);
      return;
    }
    schedulePlay(decoded.buffer, toApply.positionSec, toApply.anchorServerTime, offsetMs, toApply.trackVersion);
  }, [roomJoined, hasLatestState, clockSynced, decodedVersion, state.track?.version, state.playback?.version]);

  // Phase 6.2A.1 (Issue 2 fix): retires a locally-playing source that
  // belongs to a track the server has already moved on from, at the
  // authoritative transition time - REGARDLESS of whether this device has
  // decoded the new current track yet. Deliberately separate from the
  // recovery-apply effect above: starting the new track stays gated on
  // trackDecoded (can't schedule audio for a buffer that doesn't exist yet),
  // but a device that isn't ready to start B must still never keep playing
  // A - a stale AudioBufferSourceNode doesn't know or care that a Next/auto-
  // advance happened server-side. Declared AFTER the recovery-apply effect
  // so that on a normal (ready) transition, schedulePlay above already
  // updated getCurrentTrackVersion() to match before this runs, making it a
  // no-op there - it only actually does something for an unready device
  // (the exact "unready device becomes silent" case from the Phase 6.2B
  // brief), and its own schedulePause is itself a no-op if nothing is
  // playing. Reuses schedulePause verbatim rather than a new stop-only
  // primitive - it already does exactly "stop whatever's playing at this
  // server time, touch nothing else".
  useEffect(() => {
    const pb = state.playback;
    if (!pb || pb.status !== 'playing') return;
    const activeTrackVersion = getCurrentTrackVersion();
    if (activeTrackVersion === null || activeTrackVersion === pb.trackVersion) return;
    const offsetMs = getClockOffsetMs();
    schedulePause(pb.anchorServerTime, offsetMs);
  }, [state.playback?.trackVersion, state.playback?.anchorServerTime, state.playback?.status]);

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
      const durationSec = state.track?.durationSec ?? null;
      const expectedPositionSec = computeExpectedPositionSec(pb, nowServerMs, durationSec);
      const drift = computeDriftMs(actualPositionSec, expectedPositionSec);
      setDriftMs(drift);
      recordDriftSampleGlobal(drift); // Phase 7 benchmark facility - raw sample, never fabricated

      const nextState = evaluateDriftSample(driftStateRef.current, drift, Date.now());
      driftStateRef.current = nextState;
      setCorrectionCount(nextState.correctionCount);
      if (nextState.didCorrect) recordCorrectionGlobal();

      socket.emit('playback:driftReport', { driftMs: drift, correctionCount: nextState.correctionCount });

      if (nextState.didCorrect) {
        const correctionAnchorServerTime = nowServerMs + DEFAULT_CORRECTION_LEAD_MS;
        const correctedPositionSec = computeExpectedPositionSec(pb, correctionAnchorServerTime, durationSec);
        schedulePlay(decoded.buffer, correctedPositionSec, correctionAnchorServerTime, offsetMs, pb.trackVersion);
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

  // Phase 6.2B roles: promote/demote/transfer are PRIMARY-host-only
  // (mirrors the server's requireHost vs requireController split - see
  // socketUtils.js). Playback/queue control is allowed for the primary host
  // OR a co-host (canControl), computed from the authoritative isCoHost flag
  // the server already includes per client, not a separately-tracked local
  // flag that could go stale.
  function handleRoleAction(event, targetSocketId) {
    socket.emit(event, { targetSocketId }, () => {});
  }

  const isHost = state.hostId === socket.id; // PRIMARY host only
  const myClient = state.clients.find((c) => c.id === socket.id);
  const isCoHost = !!myClient?.isCoHost;
  const canControl = isHost || isCoHost;
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
      <InvitePanel roomCode={state.roomCode} />
      {!state.hostId && <p className="warning">No host in this room right now.</p>}
      {isHost && <p className="host-tag">You are the primary host.</p>}
      {isCoHost && <p className="host-tag">You are a co-host.</p>}

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

      <TrackPanel isHost={canControl} track={state.track} />

      <PlaybackControls
        isHost={canControl}
        playback={state.playback || DEFAULT_PLAYBACK}
        trackDurationSec={state.track?.durationSec ?? null}
      />

      <QueuePanel isHost={canControl} queue={state.queue || []} clients={state.clients} />

      <h2>Connected devices ({state.clients.length})</h2>
      <DeviceList
        clients={state.clients}
        mySocketId={socket.id}
        isPrimaryHost={isHost}
        onPromote={(id) => handleRoleAction('room:promoteCoHost', id)}
        onDemote={(id) => handleRoleAction('room:demoteCoHost', id)}
        onTransfer={(id) => handleRoleAction('room:transferHost', id)}
      />

      <Diagnostics driftMs={driftMs} correctionCount={correctionCount} />

      <BenchmarkPanel rttMs={myClient?.rtt ?? null} />

      <LocalSettings audioEnabled={audioEnabled} />
    </div>
  );
}

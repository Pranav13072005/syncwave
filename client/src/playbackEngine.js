// Web Audio scheduling for the authoritative playback state broadcast by the
// server (room.playback, see server/roomManager.js). AudioBufferSourceNode
// is one-shot, so every play/seek creates a fresh node; the outgoing node
// (if any) and the incoming node are both scheduled against the SAME future
// AudioContext time, so a seek/replace is a synchronized cut across devices
// rather than a race between "stop old" and "start new".
import { getAudioContext } from './audioEngine.js';

let currentSource = null;
let currentAnchor = null; // { audioContextTime, bufferOffsetSec } - the Web Audio scheduling anchor for whatever is currently playing/scheduled; null when nothing is
// Phase 6.2A.1: the playback.trackVersion the currently-scheduled/playing
// source belongs to (null when nothing is playing). Lets a caller detect
// "the authoritative current track has moved on, but I haven't started the
// new one yet" independently of buffer readiness - see getCurrentTrackVersion.
let currentTrackVersion = null;

// Pure-ish getter: which track (by playback.trackVersion) is the locally
// active source actually for, if any. Room.jsx uses this to decide whether a
// locally playing source has become stale (belongs to a track that's no
// longer the authoritative current one) and must be retired even before this
// device has decoded the new track's buffer - see the Phase 6.2A.1 "retire
// stale source" effect.
export function getCurrentTrackVersion() {
  return currentTrackVersion;
}

// Phase 6.2B: a single persistent GainNode sitting between every
// AudioBufferSourceNode and the destination, so local volume/mute survives
// source recreation across Play/Seek/drift correction/Next - the gain node
// itself is never recreated, only (re)connected to by fresh sources. Purely
// local: never touches authoritative playback state, never sent to other
// devices, never affects synchronization (it's downstream of scheduling, not
// part of it).
let gainNode = null;

function getGainNode() {
  const ctx = getAudioContext();
  if (!gainNode) {
    gainNode = ctx.createGain();
    gainNode.connect(ctx.destination);
  }
  return gainNode;
}

// Sets local playback volume (0-1 linear gain). Callers (LocalSettings.jsx)
// compute the effective value themselves (e.g. 0 while muted) rather than
// this module tracking a separate "muted" concept - one number, one job.
export function setVolume(volume) {
  const clamped = Math.max(0, Math.min(1, volume));
  getGainNode().gain.value = clamped;
}

export function getVolume() {
  return gainNode ? gainNode.gain.value : 1;
}

// Phase 6.2B: local device-latency calibration, kept entirely separate from
// the Phase 3 network clock offset - see recoveryState.js/clockSync.js for
// that. A positive calibrationOffsetMs means "start this device's audio
// EARLIER" (compensating for output-path latency - e.g. Bluetooth/DAC
// delay - so the audible sound lands closer to the intended instant).
// Applied only in the LIVE scheduling wrapper below, never in
// computeAudioContextStartTime itself, so the pure/tested clock-conversion
// formula is untouched - this is purely an additive local adjustment on top
// of it.
let calibrationOffsetMs = 0;

export function setCalibrationOffsetMs(ms) {
  calibrationOffsetMs = Number.isFinite(ms) ? ms : 0;
}

export function getCalibrationOffsetMs() {
  return calibrationOffsetMs;
}

// Pure: converts a server-anchored target time into a local AudioContext
// time. offsetMs follows the Phase 3 convention (serverTime = clientTime +
// offsetMs), so clientTime = serverTime - offsetMs. Exported separately so
// the math is unit-testable without a real AudioContext/socket.
export function computeAudioContextStartTime({ anchorServerTime, offsetMs, nowMs, audioContextCurrentTime }) {
  const targetClientTime = anchorServerTime - (offsetMs ?? 0);
  const delaySec = (targetClientTime - nowMs) / 1000;
  return audioContextCurrentTime + delaySec;
}

// Live wrapper around computeAudioContextStartTime using the real clock/
// offset/AudioContext, PLUS the local calibration adjustment on top of the
// network clock offset - see setCalibrationOffsetMs above for the sign
// convention and why it's applied here rather than in the pure function.
function scheduleTimeFor(anchorServerTime, offsetMs) {
  const ctx = getAudioContext();
  return computeAudioContextStartTime({
    anchorServerTime,
    offsetMs: (offsetMs ?? 0) + calibrationOffsetMs,
    nowMs: Date.now(),
    audioContextCurrentTime: ctx.currentTime,
  });
}

// Pure: a playback update should only be applied if its version is strictly
// newer than the last one this client actually applied. Protects against
// out-of-order/duplicate room:update broadcasts re-triggering scheduling.
export function isNewerPlaybackVersion(incomingVersion, lastAppliedVersion) {
  return incomingVersion > lastAppliedVersion;
}

// Pure: actual playback position (track-time seconds) from the engine's
// scheduling anchor and the current AudioContext time. Clamped so a moment
// before the anchor's start time (still in the pre-roll window) reads as the
// anchor's own offset rather than going negative. Returns null if nothing is
// currently scheduled/playing (e.g. paused, or never started).
export function computeActualPosition(anchor, audioContextCurrentTime) {
  if (!anchor) return null;
  return anchor.bufferOffsetSec + Math.max(0, audioContextCurrentTime - anchor.audioContextTime);
}

// Live wrapper around computeActualPosition using the engine's real anchor/AudioContext.
export function getActualPositionSec() {
  return computeActualPosition(currentAnchor, getAudioContext().currentTime);
}

// Schedules `buffer` to start playing at `offsetSec` into the track, timed
// to begin at the server's `anchorServerTime`. If something is already
// scheduled/playing, it's stopped at that exact same instant so devices cut
// over together rather than overlapping or leaving a device-local gap.
export function schedulePlay(buffer, offsetSec, anchorServerTime, offsetMs, trackVersion = null) {
  const ctx = getAudioContext();
  const whenSec = Math.max(ctx.currentTime, scheduleTimeFor(anchorServerTime, offsetMs));
  const safeOffset = Math.max(0, offsetSec);

  const previousSource = currentSource;
  if (safeOffset < buffer.duration) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(getGainNode());
    // Local cleanup only when the track naturally reaches its end - never
    // emits anything, and never touches authoritative state (the server's
    // own end timer, not this event, is what decides natural completion for
    // the room). .stop() is also called intentionally for pause/seek/drift-
    // correction/recovery, which fires onended too, so this must only ever
    // clear state for the source that's STILL current - a `.stop()`'d node
    // whose replacement has already been scheduled must not clobber it.
    source.onended = () => {
      if (currentSource === source) {
        currentSource = null;
        currentAnchor = null;
        currentTrackVersion = null;
      }
    };
    source.start(whenSec, safeOffset);
    currentSource = source;
    currentAnchor = { audioContextTime: whenSec, bufferOffsetSec: safeOffset };
    currentTrackVersion = trackVersion;
  } else {
    // Seeking at/past the end of the track: nothing to play, just stop.
    currentSource = null;
    currentAnchor = null;
    currentTrackVersion = null;
  }

  if (previousSource) {
    try {
      previousSource.stop(whenSec);
    } catch {
      // already stopped/ended - fine to ignore
    }
  }
}

// Schedules stopping whatever is currently playing at the server's
// anchorServerTime. A no-op (not an error) if nothing is currently playing -
// e.g. a device that was never READY, or one that's already paused.
export function schedulePause(anchorServerTime, offsetMs) {
  if (!currentSource) return;
  const ctx = getAudioContext();
  const whenSec = anchorServerTime != null
    ? Math.max(ctx.currentTime, scheduleTimeFor(anchorServerTime, offsetMs))
    : ctx.currentTime;
  try {
    currentSource.stop(whenSec);
  } catch {
    // already stopped/ended
  }
  currentSource = null;
  currentAnchor = null;
  currentTrackVersion = null;
}

// Immediately stops and discards any scheduled/playing source - used when
// leaving a room so audio doesn't keep playing into a different session.
export function resetPlaybackEngine() {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // already stopped/ended
    }
    try {
      currentSource.disconnect();
    } catch {
      // already disconnected
    }
    currentSource = null;
  }
  currentAnchor = null;
  currentTrackVersion = null;
}

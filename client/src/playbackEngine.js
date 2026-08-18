// Web Audio scheduling for the authoritative playback state broadcast by the
// server (room.playback, see server/roomManager.js). AudioBufferSourceNode
// is one-shot, so every play/seek creates a fresh node; the outgoing node
// (if any) and the incoming node are both scheduled against the SAME future
// AudioContext time, so a seek/replace is a synchronized cut across devices
// rather than a race between "stop old" and "start new".
import { getAudioContext } from './audioEngine.js';

let currentSource = null;
let currentAnchor = null; // { audioContextTime, bufferOffsetSec } - the Web Audio scheduling anchor for whatever is currently playing/scheduled; null when nothing is

// Pure: converts a server-anchored target time into a local AudioContext
// time. offsetMs follows the Phase 3 convention (serverTime = clientTime +
// offsetMs), so clientTime = serverTime - offsetMs. Exported separately so
// the math is unit-testable without a real AudioContext/socket.
export function computeAudioContextStartTime({ anchorServerTime, offsetMs, nowMs, audioContextCurrentTime }) {
  const targetClientTime = anchorServerTime - (offsetMs ?? 0);
  const delaySec = (targetClientTime - nowMs) / 1000;
  return audioContextCurrentTime + delaySec;
}

// Live wrapper around computeAudioContextStartTime using the real clock/offset/AudioContext.
function scheduleTimeFor(anchorServerTime, offsetMs) {
  const ctx = getAudioContext();
  return computeAudioContextStartTime({
    anchorServerTime,
    offsetMs,
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
export function schedulePlay(buffer, offsetSec, anchorServerTime, offsetMs) {
  const ctx = getAudioContext();
  const whenSec = Math.max(ctx.currentTime, scheduleTimeFor(anchorServerTime, offsetMs));
  const safeOffset = Math.max(0, offsetSec);

  const previousSource = currentSource;
  if (safeOffset < buffer.duration) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(whenSec, safeOffset);
    currentSource = source;
    currentAnchor = { audioContextTime: whenSec, bufferOffsetSec: safeOffset };
  } else {
    // Seeking at/past the end of the track: nothing to play, just stop.
    currentSource = null;
    currentAnchor = null;
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
}

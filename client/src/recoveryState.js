// Pure prerequisite-gating logic for Phase 6 recovery (late join + Socket.IO
// reconnect). Synchronized playback must never be scheduled until ALL of:
// the room has been (re)joined by this exact connection, the latest
// authoritative state has been received, the current track is decoded, and
// this device's clock is synchronized (a real completed sync - never a 0ms
// fallback). If a playback update arrives before prerequisites are met, only
// the newest one is kept (never queued) and applied once everything becomes
// ready. Kept free of React/socket/timer/AudioContext so it's directly
// unit-testable; Room.jsx is the only caller and owns all the side effects.
import { isNewerPlaybackVersion } from './playbackEngine.js';

export function arePrerequisitesMet({ roomJoined, hasLatestState, trackDecoded, clockSynced }) {
  return !!(roomJoined && hasLatestState && trackDecoded && clockSynced);
}

export function createInitialRecoveryState() {
  return { pendingPlaybackState: null, appliedVersion: -1 };
}

// Records a newly-arrived authoritative playback state as "pending",
// discarding whatever was pending before - only the newest state ever
// matters, so this is intentionally NOT a queue.
export function receivePlaybackState(state, playbackState) {
  return { ...state, pendingPlaybackState: playbackState };
}

// If prerequisites are met and there's a pending state newer than what was
// last applied, "consumes" it: returns the next state (pending cleared,
// appliedVersion advanced) plus the state to actually schedule. A pending
// state that's already stale (version <= appliedVersion - e.g. a duplicate
// or out-of-order broadcast) is discarded without being applied. Returns
// `toApply: null` whenever nothing should be scheduled this call.
export function tryConsumePending(state, prereqs) {
  if (!state.pendingPlaybackState) {
    return { nextState: state, toApply: null };
  }
  if (!arePrerequisitesMet(prereqs)) {
    return { nextState: state, toApply: null };
  }
  if (!isNewerPlaybackVersion(state.pendingPlaybackState.version, state.appliedVersion)) {
    return { nextState: { ...state, pendingPlaybackState: null }, toApply: null };
  }
  const toApply = state.pendingPlaybackState;
  return {
    nextState: { pendingPlaybackState: null, appliedVersion: toApply.version },
    toApply,
  };
}

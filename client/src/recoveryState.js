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
import { computeExpectedPositionSec } from './driftMonitor.js';

// Local scheduling lead for recovery apply: no network round trip is needed
// for this per-device decision, just enough lead for Web Audio to schedule
// reliably (same rationale as driftMonitor.js's correction lead - kept as
// its own constant so the two can be tuned independently). Raised from an
// original 150ms to 300ms (Phase 6.2A.1) - real mobile-browser testing with
// several devices recovering at once found 150ms too tight for a device
// that's also under load finishing a decode/clock-sync, occasionally
// missing the scheduled AudioContext start. 300ms sits in the 250-400ms
// range found reliable without approaching the ~1000ms room-wide command
// lead (which stays untouched - this is a purely local, per-device value).
export const RECOVERY_SCHEDULING_LEAD_MS = 300;

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

// Pure: for a 'playing' authoritative state, computes the CONCRETE
// {positionSec, anchorServerTime} to actually schedule, given the current
// estimated server time. Bug fix (regression covered by tests below): a
// late joiner (or a client resuming after a while disconnected) must NOT
// start from the state's original positionSec/anchorServerTime as-is - that
// snapshot is only valid at the moment the command was issued, and by the
// time a late/recovering client is ready, real time has moved on.
//
// Never schedules earlier than the state's own anchorServerTime, so a
// promptly-received command (the normal case) is completely unaffected -
// targetServerTime just equals anchorServerTime and positionSec passes
// through unchanged. This only matters once anchorServerTime is already in
// the past. Reuses computeExpectedPositionSec (the same canonical-position
// formula the server's getCanonicalPosition and the drift monitor already
// use) rather than duplicating the math. Clamps to durationSec when known,
// so a very late apply never proposes a position past the end of the track.
export function computeScheduledPlayingState(playback, nowServerTimeMs, { leadMs = RECOVERY_SCHEDULING_LEAD_MS, durationSec = null } = {}) {
  const targetServerTime = Math.max(playback.anchorServerTime, nowServerTimeMs + leadMs);
  const positionSec = computeExpectedPositionSec(playback, targetServerTime, durationSec);
  return { ...playback, positionSec, anchorServerTime: targetServerTime };
}

// If prerequisites are met and there's a pending state newer than what was
// last applied, "consumes" it: returns the next state (pending cleared,
// appliedVersion advanced) plus the state to actually schedule. A pending
// state that's already stale (version <= appliedVersion - e.g. a duplicate
// or out-of-order broadcast) is discarded without being applied. Returns
// `toApply: null` whenever nothing should be scheduled this call - in
// particular, ALWAYS while any prerequisite is unmet, so a late joiner (or a
// client mid-reconnect) produces no scheduling instruction, and therefore no
// audio, until room join + latest state + track decode + clock sync are ALL
// satisfied. `context.nowServerTimeMs` (this client's current estimated
// server time - Date.now() + its Phase 3 offset) is required whenever the
// pending state is 'playing'; it's what computeScheduledPlayingState uses to
// calculate the correct start position instead of a stale snapshot.
export function tryConsumePending(state, prereqs, context = {}) {
  if (!state.pendingPlaybackState) {
    return { nextState: state, toApply: null };
  }
  if (!arePrerequisitesMet(prereqs)) {
    return { nextState: state, toApply: null };
  }
  const raw = state.pendingPlaybackState;
  if (!isNewerPlaybackVersion(raw.version, state.appliedVersion)) {
    return { nextState: { ...state, pendingPlaybackState: null }, toApply: null };
  }
  const toApply = raw.status === 'playing'
    ? computeScheduledPlayingState(raw, context.nowServerTimeMs, { leadMs: context.leadMs, durationSec: context.durationSec })
    : raw;
  return {
    nextState: { pendingPlaybackState: null, appliedVersion: raw.version },
    toApply,
  };
}

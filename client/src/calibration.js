// Phase 6.2B: persists the local device-latency calibration offset in
// localStorage so it survives a reload, WITHOUT syncing it anywhere - it's
// deliberately per-browser/per-device, never sent to the server or other
// participants (see playbackEngine.js's setCalibrationOffsetMs for how it's
// actually used). Fails silently if localStorage is unavailable (privacy
// mode, disabled storage, etc.) - calibration is a convenience, not a
// requirement for the app to function.
const STORAGE_KEY = 'syncwave:calibrationOffsetMs';

export function loadCalibrationOffsetMs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function saveCalibrationOffsetMs(ms) {
  try {
    localStorage.setItem(STORAGE_KEY, String(ms));
  } catch {
    // ignore - persistence is best-effort
  }
}

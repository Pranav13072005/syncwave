import { useEffect, useState } from 'react';
import { setVolume as engineSetVolume, setCalibrationOffsetMs as engineSetCalibrationOffsetMs } from '../playbackEngine';
import { loadCalibrationOffsetMs, saveCalibrationOffsetMs } from '../calibration';
import { isWakeLockSupported, requestWakeLock, releaseWakeLock } from '../wakeLock';

const CALIBRATION_MIN_MS = -200;
const CALIBRATION_MAX_MS = 200;
const CALIBRATION_STEP_MS = 5;

// Local-only device settings (Phase 6.2B): volume/mute, latency calibration,
// and Screen Wake Lock. None of these touch authoritative room state or are
// visible to other participants - see playbackEngine.js/calibration.js/
// wakeLock.js for exactly how each is applied.
export default function LocalSettings({ audioEnabled }) {
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [calibrationMs, setCalibrationMs] = useState(() => loadCalibrationOffsetMs());
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const wakeLockSupported = isWakeLockSupported();

  useEffect(() => {
    engineSetVolume(muted ? 0 : volume);
  }, [volume, muted]);

  useEffect(() => {
    engineSetCalibrationOffsetMs(calibrationMs);
    saveCalibrationOffsetMs(calibrationMs);
  }, [calibrationMs]);

  // Requests the wake lock once audio is enabled (a user gesture already
  // happened, which some browsers require), and reacquires it whenever the
  // tab becomes visible again - the browser auto-releases it when a tab is
  // hidden, so without this a device that's briefly backgrounded (e.g.
  // checking a notification) would silently lose it permanently. Released
  // on unmount/leaving the room.
  useEffect(() => {
    if (!audioEnabled) return;
    let cancelled = false;

    async function acquire() {
      const ok = await requestWakeLock();
      if (!cancelled) setWakeLockActive(ok);
    }
    acquire();

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') acquire();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseWakeLock();
      setWakeLockActive(false);
    };
  }, [audioEnabled]);

  return (
    <div className="local-settings-panel">
      <h2>Local Device Settings</h2>

      <div className="setting-row">
        <label htmlFor="volume-slider">Volume</label>
        <input
          id="volume-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={volume}
          disabled={muted}
          onChange={(e) => setVolumeState(parseFloat(e.target.value))}
        />
        <button onClick={() => setMuted((m) => !m)}>{muted ? 'Unmute' : 'Mute'}</button>
      </div>

      <div className="setting-row">
        <label htmlFor="calibration-slider">
          Device Sync Offset: {calibrationMs >= 0 ? '+' : ''}
          {calibrationMs}ms
        </label>
        <input
          id="calibration-slider"
          type="range"
          min={CALIBRATION_MIN_MS}
          max={CALIBRATION_MAX_MS}
          step={CALIBRATION_STEP_MS}
          value={calibrationMs}
          onChange={(e) => setCalibrationMs(parseFloat(e.target.value))}
        />
        <button onClick={() => setCalibrationMs(0)}>Reset to 0</button>
      </div>

      <p className="hint">
        Keep Screen Awake: {!wakeLockSupported ? 'Unsupported' : wakeLockActive ? 'On' : 'Off'}
      </p>
    </div>
  );
}

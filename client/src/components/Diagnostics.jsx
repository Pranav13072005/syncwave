import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../socket';
import { runClockSync } from '../clockSync';

const STATUS_LABELS = {
  idle: 'Not synced yet',
  syncing: 'Synchronizing…',
  synced: 'Synced',
  failed: 'Sync failed',
};

export default function Diagnostics({ driftMs = null, correctionCount = 0 }) {
  const [status, setStatus] = useState('idle');
  const [rttMs, setRttMs] = useState(null);
  const [offsetMs, setOffsetMs] = useState(null);
  const [sampleCount, setSampleCount] = useState(0);
  const cancelledRef = useRef(false);

  const applyResult = useCallback((result) => {
    if (cancelledRef.current) return;
    setStatus(result.status);
    setRttMs(result.rttMs);
    setOffsetMs(result.offsetMs);
    setSampleCount(result.sampleCount);
    socket.emit('clock:report', {
      rtt: result.rttMs,
      offsetMs: result.offsetMs,
      status: result.status,
    });
  }, []);

  const sync = useCallback(async () => {
    setStatus('syncing');
    const result = await runClockSync(socket);
    applyResult(result);
  }, [applyResult]);

  useEffect(() => {
    cancelledRef.current = false;
    sync(); // sync on room join/mount
    socket.io.on('reconnect', sync); // and again after a reconnection
    return () => {
      cancelledRef.current = true; // ignore a still-in-flight sync from a dev-mode double-invoke
      socket.io.off('reconnect', sync);
    };
  }, [sync]);

  return (
    <div className="diagnostics-panel">
      <h2>Sync Diagnostics</h2>
      <dl className="diagnostics-grid">
        <dt>Status</dt>
        <dd className={`sync-status sync-status-${status}`}>{STATUS_LABELS[status] || status}</dd>
        <dt>RTT</dt>
        <dd>{rttMs !== null ? `${rttMs.toFixed(0)} ms` : '—'}</dd>
        <dt>Clock offset</dt>
        <dd>{offsetMs !== null ? `${offsetMs.toFixed(1)} ms` : '—'}</dd>
        <dt>Samples used</dt>
        <dd>{sampleCount || '—'}</dd>
        <dt>Playback drift</dt>
        <dd>{driftMs !== null ? `${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)} ms` : '—'}</dd>
        <dt>Corrections</dt>
        <dd>{correctionCount}</dd>
      </dl>
      <button onClick={sync} disabled={status === 'syncing'}>
        Re-sync
      </button>
    </div>
  );
}

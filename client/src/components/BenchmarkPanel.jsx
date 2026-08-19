import { useEffect, useState } from 'react';
import { getBenchmarkSnapshot, summarizeAbsDrift } from '../benchmark';
import { getClockOffsetMs } from '../clockSync';

// Phase 7 development/benchmark facility: surfaces REAL measurements
// collected during this session (never fabricated) so they can be copied
// into docs/benchmarks.md after a real-device test run. Collapsed by
// default (<details>, no extra JS needed) so it doesn't clutter the normal
// UX - see PROJECT_CONTEXT.md for exactly how/where each number is recorded
// (Room.jsx wires the recordX calls; this just reads + formats them).
export default function BenchmarkPanel({ rttMs }) {
  const [, forceTick] = useState(0);

  // Polls rather than subscribing - the underlying benchmark.js state is a
  // plain module-level object (same pattern as clockSync.js), not wired
  // through React state, since it's updated from several unrelated call
  // sites (drift ticks, recovery apply) that shouldn't each need to know
  // about this panel's render cycle.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const snapshot = getBenchmarkSnapshot();
  const summary = summarizeAbsDrift(snapshot.driftSamples);

  const report = {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    rttMs,
    clockOffsetMs: getClockOffsetMs(),
    driftSampleCount: summary.count,
    meanAbsDriftMs: summary.meanAbsMs,
    medianAbsDriftMs: summary.medianAbsMs,
    p95AbsDriftMs: summary.p95AbsMs,
    maxAbsDriftMs: summary.maxAbsMs,
    correctionCount: snapshot.correctionCount,
    joinRecoveryMs: snapshot.joinRecoveryMs,
    reconnectRecoveryMsSamples: snapshot.reconnectRecoveryMsSamples,
  };

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    } catch {
      // Clipboard unavailable - the numbers are still visible below for manual copy.
    }
  }

  const fmt = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(1)}ms`);

  return (
    <details className="benchmark-panel">
      <summary>Benchmark data (for docs/benchmarks.md)</summary>
      <dl className="diagnostics-grid">
        <dt>Drift samples</dt>
        <dd>{summary.count}</dd>
        <dt>Mean abs drift</dt>
        <dd>{fmt(summary.meanAbsMs)}</dd>
        <dt>Median abs drift</dt>
        <dd>{fmt(summary.medianAbsMs)}</dd>
        <dt>P95 abs drift</dt>
        <dd>{fmt(summary.p95AbsMs)}</dd>
        <dt>Max abs drift</dt>
        <dd>{fmt(summary.maxAbsMs)}</dd>
        <dt>Corrections</dt>
        <dd>{snapshot.correctionCount}</dd>
        <dt>Join recovery time</dt>
        <dd>{snapshot.joinRecoveryMs !== null ? `${snapshot.joinRecoveryMs.toFixed(0)}ms` : '—'}</dd>
        <dt>Reconnect recovery times</dt>
        <dd>{snapshot.reconnectRecoveryMsSamples.length ? snapshot.reconnectRecoveryMsSamples.map((v) => `${v.toFixed(0)}ms`).join(', ') : '—'}</dd>
      </dl>
      <button onClick={copyReport}>Copy report as JSON</button>
    </details>
  );
}

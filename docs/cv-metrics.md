# SyncWave — CV / Resume Metrics

Status: **no real-device measurements have been entered yet.** Every field
below is `TO_BE_MEASURED` until filled in from an actual completed run of
`docs/benchmarks.md`'s procedure. Do not copy any of these fields into a
resume/CV/portfolio until they carry a real, measured value - an unfilled
`TO_BE_MEASURED` is not a metric.

| Metric | Value | Source |
|---|---|---|
| Maximum devices successfully tested simultaneously | TO_BE_MEASURED | `docs/benchmarks.md` §4 |
| Mean absolute client-reported drift | TO_BE_MEASURED | `docs/benchmarks.md` §4 |
| Median absolute client-reported drift | TO_BE_MEASURED | `docs/benchmarks.md` §4 |
| P95 absolute client-reported drift | TO_BE_MEASURED | `docs/benchmarks.md` §4 |
| Maximum absolute client-reported drift observed | TO_BE_MEASURED | `docs/benchmarks.md` §4 |
| Reconnect recovery time (typical) | TO_BE_MEASURED | `docs/benchmarks.md` §4 |
| Late-join recovery time (typical) | TO_BE_MEASURED | `docs/benchmarks.md` §4 |
| Automated test count | 189 (110 server + 79 client) | `npm test` in `server/` and `client/`, this build |
| Real-time transport | Socket.IO (WebSocket with polling fallback) - documented, not inflated | `server/index.js`, `client/src/socket.js` |

## Notes for whoever fills this in

- "Automated test count" is the one metric that's already real (it's a
  direct count of passing `node --test` assertions) - keep it updated if the
  test suite grows after this document was written; don't let it go stale
  upward (claiming a higher count than the current `npm test` output) or
  downward (undercounting real coverage).
- Every drift metric must cite which benchmark run (device count, date) it
  came from when used externally - a single number without that context is
  easy to state out of proportion to what was actually tested.
- Do not state "sub-millisecond" or "NTP-level" synchronization claims -
  this project's own documentation (PROJECT_CONTEXT.md, README) is explicit
  that it does not claim that precision.

// Phase 6.2B: thin wrapper around the Screen Wake Lock API. Feature-detected
// (navigator.wakeLock), fails gracefully everywhere it's unsupported or
// denied (unsupported browser, insecure/HTTP context, permission denied) -
// never throws, never blocks playback. Not guaranteed to keep the screen on
// across every mobile OS/browser combination (background app suspension is
// still out of this app's control) - it's a best-effort convenience.
let sentinel = null;

export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export async function requestWakeLock() {
  if (!isWakeLockSupported()) return false;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    return true;
  } catch {
    // Insecure context, permission denied, no user activation yet, etc.
    sentinel = null;
    return false;
  }
}

export async function releaseWakeLock() {
  if (!sentinel) return;
  try {
    await sentinel.release();
  } catch {
    // already released (e.g. tab was hidden, which auto-releases it)
  }
  sentinel = null;
}

export function isWakeLockActive() {
  return sentinel !== null && !sentinel.released;
}

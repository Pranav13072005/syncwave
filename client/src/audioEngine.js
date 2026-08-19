// Shared AudioContext singleton. Browsers (especially mobile) require an
// explicit user gesture before audio can play, so the context is only
// created/resumed from unlockAudioContext(), called from a click handler.
let audioContext = null;
//audiocontext = new (window.AudioContext || window.webkitAudioContext)();
export function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

export async function unlockAudioContext() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  return ctx;
}

// Phase 6.2A.1: dedupes concurrent decode requests for the SAME url - e.g.
// the current-track decode effect and the next-track preload effect both
// happening to target the same file, or a dev-mode StrictMode double-invoke.
// Without this, two callers would each start their own fetch+decode
// independently; with it, the second caller just awaits the first's
// in-flight promise. Entries are removed once settled (success or failure)
// so a later, genuinely fresh request isn't served a stale cached promise.
const inFlightDecodes = new Map(); // url -> Promise<AudioBuffer>

// Downloads and decodes a track. onStatus (optional) is called with
// 'downloading' then 'decoding' so callers can show progress (only the
// caller that actually triggered the fetch sees status updates - a caller
// that joined an already-in-flight decode just awaits the shared promise).
export async function decodeTrackFromUrl(url, { onStatus } = {}) {
  const existing = inFlightDecodes.get(url);
  if (existing) return existing;

  const promise = (async () => {
    const ctx = getAudioContext();
    onStatus?.('downloading');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    onStatus?.('decoding');
    return ctx.decodeAudioData(arrayBuffer);
  })();

  inFlightDecodes.set(url, promise);
  try {
    return await promise;
  } finally {
    inFlightDecodes.delete(url);
  }
}

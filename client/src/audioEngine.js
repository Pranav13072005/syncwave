// Shared AudioContext singleton. Browsers (especially mobile) require an
// explicit user gesture before audio can play, so the context is only
// created/resumed from unlockAudioContext(), called from a click handler.
let audioContext = null;

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

// Downloads and decodes a track. onStatus (optional) is called with
// 'downloading' then 'decoding' so callers can show progress.
export async function decodeTrackFromUrl(url, { onStatus } = {}) {
  const ctx = getAudioContext();
  onStatus?.('downloading');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  onStatus?.('decoding');
  return ctx.decodeAudioData(arrayBuffer);
}

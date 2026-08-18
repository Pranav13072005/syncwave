// Generates a small self-contained WAV test tone so Phase 0 doesn't require
// sourcing an external audio file. Two devices load this same static file.
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION_SEC = 6;
const FREQ_HZ = 440;
const AMPLITUDE = 0.3;

const numSamples = SAMPLE_RATE * DURATION_SEC;
const dataSize = numSamples * 2; // 16-bit mono
const buffer = Buffer.alloc(44 + dataSize);

buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16); // PCM chunk size
buffer.writeUInt16LE(1, 20); // PCM format
buffer.writeUInt16LE(1, 22); // mono
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
buffer.writeUInt16LE(2, 32); // block align
buffer.writeUInt16LE(16, 34); // bits per sample
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

// A short fade in/out so the tone has an audible attack/decay edge,
// which makes sync drift audible (clicks reveal misalignment) when testing.
const fadeSamples = SAMPLE_RATE * 0.02;
for (let i = 0; i < numSamples; i++) {
  let envelope = 1;
  if (i < fadeSamples) envelope = i / fadeSamples;
  else if (i > numSamples - fadeSamples) envelope = (numSamples - i) / fadeSamples;

  const t = i / SAMPLE_RATE;
  // A tick every second (short burst) makes it easy to hear sync/drift by ear.
  const tickPhase = t % 1;
  const tick = tickPhase < 0.05 ? 1 : 0.15;

  const sample = Math.sin(2 * Math.PI * FREQ_HZ * t) * AMPLITUDE * envelope * tick;
  buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
}

const outDir = path.join(__dirname, '..', 'public', 'audio');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'test-tone.wav');
fs.writeFileSync(outPath, buffer);
console.log(`Generated ${outPath} (${DURATION_SEC}s, ${FREQ_HZ}Hz, 1 tick/sec)`);

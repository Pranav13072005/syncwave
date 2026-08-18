// Phase 0 PoC client logic.
// Proves: socket connection, shared local audio, and future-server-time
// scheduled Web Audio playback using a basic (single-sample) clock offset.
// This file is intentionally simple and will be replaced by modular
// client/socket.js, client/audioEngine.js, client/clockSync.js in later phases.

const logEl = document.getElementById('log');
function log(msg) {
  const t = new Date().toISOString().substr(11, 12);
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

const statConn = document.getElementById('stat-conn');
const statOffset = document.getElementById('stat-offset');
const statRtt = document.getElementById('stat-rtt');
const statAudio = document.getElementById('stat-audio');
const btnLoad = document.getElementById('btn-load');
const btnPlay = document.getElementById('btn-play');

let clockOffsetMs = 0; // estimated serverTime - clientTime
let audioCtx = null;
let audioBuffer = null;

const socket = io();

socket.on('connect', () => {
  statConn.textContent = 'connected';
  log(`Connected to server as ${socket.id}`);
  measureClockOffset();
});

socket.on('disconnect', () => {
  statConn.textContent = 'disconnected';
  log('Disconnected from server');
});

function measureClockOffset() {
  const clientSendTime = Date.now();
  socket.emit('clock:ping', clientSendTime, ({ serverTime, clientSendTime: echoedSend }) => {
    const clientReceiveTime = Date.now();
    const rtt = clientReceiveTime - echoedSend;
    // Cristian's algorithm: assume symmetric one-way delay.
    const estimatedServerTimeAtReceive = serverTime + rtt / 2;
    clockOffsetMs = estimatedServerTimeAtReceive - clientReceiveTime;

    statRtt.textContent = rtt;
    statOffset.textContent = clockOffsetMs.toFixed(1);
    log(`Clock offset estimated: ${clockOffsetMs.toFixed(1)}ms (RTT ${rtt}ms)`);
  });
}

btnLoad.addEventListener('click', async () => {
  btnLoad.disabled = true;
  statAudio.textContent = 'downloading...';
  log('Fetching audio file...');
  try {
    const response = await fetch('/audio/test-tone.wav');
    const arrayBuffer = await response.arrayBuffer();

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    statAudio.textContent = 'decoding...';
    log('Decoding audio...');
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    statAudio.textContent = 'READY';
    log(`Audio decoded: ${audioBuffer.duration.toFixed(2)}s. Device is READY.`);
    btnPlay.disabled = false;
  } catch (err) {
    statAudio.textContent = 'error';
    log(`Audio load/decode failed: ${err.message}`);
    btnLoad.disabled = false;
  }
});

btnPlay.addEventListener('click', () => {
  // Unlock/resume AudioContext on user gesture, as required by browsers.
  if (audioCtx.state === 'suspended') audioCtx.resume();
  log('Requesting scheduled play from server...');
  socket.emit('poc:requestPlay');
});

socket.on('poc:scheduledPlay', ({ targetServerTime, startOffsetSec }) => {
  if (!audioBuffer || !audioCtx) {
    log('Received scheduledPlay but audio not loaded yet - ignoring.');
    return;
  }

  // Convert the authoritative future server timestamp into a local delay
  // using our clock offset estimate, then schedule against
  // audioCtx.currentTime (never call this "immediately").
  const targetClientTime = targetServerTime - clockOffsetMs;
  const delayMs = targetClientTime - Date.now();
  const delaySec = Math.max(0, delayMs / 1000);

  log(`Scheduled play: targetServerTime=${targetServerTime}, computed delay=${delayMs.toFixed(0)}ms`);

  // AudioBufferSourceNode is one-shot - always create a fresh one.
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);
  source.start(audioCtx.currentTime + delaySec, startOffsetSec || 0);

  log(`source.start() scheduled ${delaySec.toFixed(3)}s from now`);
});

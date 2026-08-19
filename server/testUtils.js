// Shared Socket.IO integration-test helpers (Phase 7 code-quality pass) -
// extracted from what had been independently copy-pasted near-verbatim into
// most of test/'s *.integration-style test files. Kept intentionally
// tiny/generic. playback.integration.test.js keeps its own local uploadTrack
// variant (a differently-shaped signature, takes an explicit baseUrl) rather
// than being forced to conform - not every file needs to use every helper
// here. Lives at server/ root, NOT under server/test/ - node's default test
// runner discovery sweeps up any .js file inside a directory literally named
// test/tests, which would otherwise make this show up as a phantom
// zero-assertion "test".
const BASE = process.env.SYNCWAVE_SERVER_URL || 'http://localhost:3001';

function waitConnected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function waitForRoomUpdate(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room:update', handler);
      reject(new Error('waitForRoomUpdate timed out'));
    }, timeoutMs);
    function handler(state) {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off('room:update', handler);
        resolve(state);
      }
    }
    socket.on('room:update', handler);
  });
}

async function uploadTrack(token, bytes, filename = 'test-tone.wav') {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: token ? { 'x-upload-token': token } : {},
    body: form,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

module.exports = { BASE, waitConnected, emitAck, waitForRoomUpdate, uploadTrack };

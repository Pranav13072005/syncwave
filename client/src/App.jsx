import { useState } from 'react';
import Landing from './components/Landing';
import Room from './components/Room';

// Phase 6.2B invite links: /room/<CODE> prefills the join form without a
// full router dependency - this app has exactly two "pages" (Landing/Room),
// so a tiny regex + history.pushState covers it without introducing
// react-router for one feature. A direct page load/refresh on /room/<CODE>
// is served by Vite's dev-server SPA fallback in local development; serving
// the production build with the same fallback is a deployment-time concern
// (see README) not wired up by this client-only app.
function parseRoomCodeFromPath() {
  const match = window.location.pathname.match(/^\/room\/([A-Za-z0-9]+)/);
  return match ? match[1].toUpperCase() : '';
}

export default function App() {
  const [roomState, setRoomState] = useState(null);
  const [initialRoomCode] = useState(parseRoomCodeFromPath);

  function handleRoomJoined(state) {
    setRoomState(state);
    window.history.pushState({}, '', `/room/${state.roomCode}`);
  }

  function handleLeave() {
    setRoomState(null);
    window.history.pushState({}, '', '/');
  }

  if (!roomState) {
    return <Landing onRoomJoined={handleRoomJoined} initialRoomCode={initialRoomCode} />;
  }

  return <Room initialState={roomState} onLeave={handleLeave} />;
}

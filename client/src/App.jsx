import { useState } from 'react';
import Landing from './components/Landing';
import Room from './components/Room';

export default function App() {
  const [roomState, setRoomState] = useState(null);

  if (!roomState) {
    return <Landing onRoomJoined={setRoomState} />;
  }

  return <Room initialState={roomState} onLeave={() => setRoomState(null)} />;
}

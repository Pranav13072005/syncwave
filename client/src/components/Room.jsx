import { useEffect, useState } from 'react';
import { socket } from '../socket';
import DeviceList from './DeviceList';

export default function Room({ initialState, onLeave }) {
  const [state, setState] = useState(initialState);
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    function handleUpdate(newState) {
      setState(newState);
    }
    function handleConnect() {
      setConnected(true);
    }
    function handleDisconnect() {
      setConnected(false);
    }

    socket.on('room:update', handleUpdate);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('room:update', handleUpdate);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, []);

  function handleLeave() {
    socket.emit('room:leave', {}, () => {
      onLeave();
    });
  }

  const isHost = state.hostId === socket.id;

  return (
    <div className="room">
      <header className="room-header">
        <div>
          <span className="conn-dot" data-connected={connected} />
          {connected ? 'Connected' : 'Disconnected'}
        </div>
        <button onClick={handleLeave}>Leave Room</button>
      </header>

      <h1>
        Room <span className="room-code">{state.roomCode}</span>
      </h1>
      {!state.hostId && <p className="warning">No host in this room right now.</p>}
      {isHost && <p className="host-tag">You are the host.</p>}

      <h2>Connected devices ({state.clients.length})</h2>
      <DeviceList clients={state.clients} mySocketId={socket.id} />
    </div>
  );
}

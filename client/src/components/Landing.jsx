import { useState } from 'react';
import { socket } from '../socket';

export default function Landing({ onRoomJoined, initialRoomCode = '' }) {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState(initialRoomCode);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function handleCreate(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    socket.emit('room:create', { name: name.trim() || 'Host' }, (res) => {
      setBusy(false);
      if (!res?.ok) {
        setError('Could not create room.');
        return;
      }
      onRoomJoined(res.state);
    });
  }

  function handleJoin(e) {
    e.preventDefault();
    setError('');
    if (!joinCode.trim()) {
      setError('Enter a room code.');
      return;
    }
    setBusy(true);
    socket.emit('room:join', { roomCode: joinCode.trim(), name: name.trim() || 'Guest' }, (res) => {
      setBusy(false);
      if (!res?.ok) {
        setError(res?.error === 'ROOM_NOT_FOUND' ? 'Room not found.' : 'Could not join room.');
        return;
      }
      onRoomJoined(res.state);
    });
  }

  return (
    <div className="landing">
      <h1>SyncWave</h1>
      <p className="subtitle">Synchronized audio playback across devices</p>

      <label className="field">
        Device / display name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex's Phone"
          maxLength={40}
        />
      </label>

      <div className="landing-actions">
        <form onSubmit={handleCreate} className="landing-card">
          <h2>Host a room</h2>
          <button type="submit" disabled={busy}>Create Room</button>
        </form>

        <form onSubmit={handleJoin} className="landing-card">
          <h2>Join a room</h2>
          {initialRoomCode && <p className="hint">Joining room {initialRoomCode} via invite link.</p>}
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            maxLength={5}
          />
          <button type="submit" disabled={busy}>Join Room</button>
        </form>
      </div>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

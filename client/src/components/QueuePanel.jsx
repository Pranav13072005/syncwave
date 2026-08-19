import { useState } from 'react';
import { socket } from '../socket';

const ERROR_MESSAGES = {
  NOT_HOST: 'Only the host can manage the queue.',
  NO_ROOM: 'You are not in a room.',
  QUEUE_EMPTY: 'The queue is empty.',
  TRACK_NOT_FOUND: 'That track is no longer in the queue.',
  INVALID_INDEX: 'Could not reorder the queue.',
};

export default function QueuePanel({ isHost, queue, clients }) {
  const [error, setError] = useState('');

  function send(event, payload) {
    setError('');
    socket.emit(event, payload, (ack) => {
      if (!ack?.ok) {
        setError(ERROR_MESSAGES[ack?.error] || 'Queue action failed.');
      }
    });
  }

  const nextReadyCount = queue.length > 0 ? clients.filter((c) => c.isNextReady).length : 0;

  return (
    <div className="queue-panel">
      <h2>Up Next</h2>
      {queue.length === 0 ? (
        <p className="hint">Queue is empty.</p>
      ) : (
        <>
          <p className="hint queue-ready-count">
            Next track ready: {nextReadyCount}/{clients.length} devices
          </p>
          <ol className="queue-list">
            {queue.map((t, i) => (
              <li key={t.trackId}>
                <span className="queue-track-name">{t.originalName}</span>
                {isHost && (
                  <span className="queue-item-controls">
                    <button disabled={i === 0} onClick={() => send('queue:reorder', { trackId: t.trackId, toIndex: i - 1 })} title="Move up">
                      ↑
                    </button>
                    <button disabled={i === queue.length - 1} onClick={() => send('queue:reorder', { trackId: t.trackId, toIndex: i + 1 })} title="Move down">
                      ↓
                    </button>
                    <button onClick={() => send('queue:remove', { trackId: t.trackId })}>Remove</button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {isHost && (
        <button onClick={() => send('queue:next', {})} disabled={queue.length === 0}>
          Next
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

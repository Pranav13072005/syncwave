export default function DeviceList({ clients, mySocketId }) {
  return (
    <ul className="device-list">
      {clients.map((c) => (
        <li key={c.id} className={c.id === mySocketId ? 'device-me' : ''}>
          <span className="device-name">{c.name}</span>
          {c.isHost && <span className="badge badge-host">HOST</span>}
          {c.id === mySocketId && <span className="badge badge-you">YOU</span>}
          {c.isReady && <span className="badge badge-ready">READY</span>}
          {typeof c.rtt === 'number' && <span className="device-rtt">RTT {c.rtt.toFixed(0)}ms</span>}
          {typeof c.driftMs === 'number' && (
            <span className="device-rtt">
              Drift {c.driftMs >= 0 ? '+' : ''}
              {c.driftMs.toFixed(0)}ms
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

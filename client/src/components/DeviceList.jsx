export default function DeviceList({ clients, mySocketId }) {
  return (
    <ul className="device-list">
      {clients.map((c) => (
        <li key={c.id} className={c.id === mySocketId ? 'device-me' : ''}>
          <span className="device-name">{c.name}</span>
          {c.isHost && <span className="badge badge-host">HOST</span>}
          {c.id === mySocketId && <span className="badge badge-you">YOU</span>}
          {c.isReady && <span className="badge badge-ready">READY</span>}
        </li>
      ))}
    </ul>
  );
}

import { useEffect, useRef, useState } from 'react';

// Phase 6.2B lightweight sharing - no accounts, no QR dependency. The invite
// URL form (/room/<CODE>) is recognized by App.jsx's tiny path parser.
export default function InvitePanel({ roomCode }) {
  const [copiedLabel, setCopiedLabel] = useState('');
  const clearTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLabel(label);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => setCopiedLabel(''), 2000);
    } catch {
      // Clipboard API unavailable/denied (e.g. insecure context, permission
      // blocked) - the code/link are still visible on screen for manual
      // copy, so this fails silently rather than showing an alarming error
      // for what's a convenience feature.
    }
  }

  const inviteUrl = `${window.location.origin}/room/${roomCode}`;

  return (
    <div className="invite-panel">
      <button onClick={() => copy(roomCode, 'Room code')}>Copy Room Code</button>
      <button onClick={() => copy(inviteUrl, 'Invite link')}>Copy Invite Link</button>
      {copiedLabel && <span className="hint"> {copiedLabel} copied!</span>}
    </div>
  );
}

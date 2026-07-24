import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import { Modal } from './ui.jsx';

const CHECK_INTERVAL_MS = 45 * 1000;
// A few seconds of slack absorbs clock drift and request latency between this
// session's own login stamp and the server's recorded timestamp for it, so
// that login itself is never mistaken for a "newer" one.
const NEWER_LOGIN_SLACK_MS = 5000;

/**
 * Warns a logged-in user if a more recent login has happened on their account
 * than the one they're currently using, e.g. someone else (or the same
 * person, another device) signed in while this session was already open.
 * Mounted once, globally, so every portal/role gets it for free rather than
 * each page wiring its own polling.
 */
export default function SessionWatcher() {
  const { user, logout } = useAuth();
  const [alertAt, setAlertAt] = useState(null); // ISO timestamp of the newer login being warned about
  // Once dismissed, don't re-show for that same login, only a login newer
  // still than the one already dismissed should ever pop it up again.
  const dismissedRef = useRef(null);

  useEffect(() => {
    if (!user) { setAlertAt(null); dismissedRef.current = null; return; }

    let cancelled = false;
    async function check() {
      const myLoginAt = localStorage.getItem('kid_login_at');
      // No stamp yet (a session that started before this feature existed),
      // nothing to compare against, skip rather than false-alarm on ourselves.
      if (!myLoginAt) return;
      try {
        const { last_login_at } = await api('/auth/session-check');
        if (cancelled || !last_login_at) return;
        const isNewer = new Date(last_login_at).getTime() > new Date(myLoginAt).getTime() + NEWER_LOGIN_SLACK_MS;
        if (isNewer && dismissedRef.current !== last_login_at) setAlertAt(last_login_at);
      } catch {
        // A failed check (offline, token mid-refresh, ...) just tries again next tick.
      }
    }

    check();
    const iv = setInterval(check, CHECK_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [user?.id]);

  if (!alertAt) return null;

  function dismiss() {
    dismissedRef.current = alertAt;
    setAlertAt(null);
  }

  return (
    <Modal title="New Sign-In Detected" onClose={dismiss} width={420}>
      <div style={{ textAlign: 'center', padding: '4px 0 4px' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#FEF2F2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
          <i className="fa-solid fa-shield-halved" style={{ fontSize: 22, color: '#DC2626' }} />
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>Your account was just signed in elsewhere</div>
        <div style={{ fontSize: 12.5, color: '#64748B', marginBottom: 18, lineHeight: 1.6 }}>
          A newer sign-in to <b>{user?.email}</b> happened on {new Date(alertAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.
          If this wasn't you, change your password right away.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" style={{ flex: 1, padding: 10 }} onClick={logout}>Log Out</button>
          <button className="btn-primary" style={{ flex: 1, padding: 10 }} onClick={dismiss}>It Was Me</button>
        </div>
      </div>
    </Modal>
  );
}

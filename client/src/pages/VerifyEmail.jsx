import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Landing page for the emailed verification link (/verify-email?token=...).
 * Confirms the account with the server, then invites the user to sign in.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');

  const [status, setStatus] = useState(token ? 'verifying' : 'error'); // verifying | success | error
  const [message, setMessage] = useState(token ? '' : 'This verification link is missing its token.');
  const ran = useRef(false);

  // Resend form (shown on error, expired/used links)
  const [email, setEmail] = useState('');
  const [resendMsg, setResendMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true; // React StrictMode mounts twice; the token is single-use
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setStatus('success'))
      .catch(ex => {
        setStatus('error');
        setMessage(ex.message);
      });
  }, [token]);

  async function resend(e) {
    e.preventDefault();
    setResendMsg('');
    setBusy(true);
    try {
      const r = await api('/auth/resend-verification', { method: 'POST', body: { email: email.trim() } });
      setResendMsg(r.message || 'A new link has been sent.');
    } catch (ex) {
      setResendMsg(ex.message);
    } finally {
      setBusy(false);
    }
  }

  const input = { width: '100%', padding: '12px 15px', border: '1px solid var(--color-border)', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box' };

  return (
    <div className="login-body">
      <div className="login-card" style={{ gridTemplateColumns: '1fr', maxWidth: 460 }}>
        <div style={{ padding: '48px 44px', textAlign: 'center' }}>
          {status === 'verifying' && (
            <>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <i className="fa-solid fa-spinner fa-spin" style={{ color: '#1F4E9E', fontSize: 30 }} />
              </div>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 24, fontWeight: 600, color: 'var(--color-ink)' }}>Verifying your email…</div>
            </>
          )}

          {status === 'success' && (
            <>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#F0FDF4', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <i className="fa-solid fa-circle-check" style={{ color: '#16A34A', fontSize: 34 }} />
              </div>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 24, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 10 }}>Email verified!</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.7, marginBottom: 24 }}>
                Your account is now active. You can sign in to the parent portal.
              </p>
              <Link
                to="/login"
                style={{ display: 'block', padding: 13, background: '#1F4E9E', color: '#fff', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, textDecoration: 'none' }}
              >
                Sign In
              </Link>
            </>
          )}

          {status === 'error' && (
            <>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#FEF2F2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <i className="fa-solid fa-circle-exclamation" style={{ color: 'var(--color-danger)', fontSize: 34 }} />
              </div>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 24, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 10 }}>Verification failed</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.7, marginBottom: 20 }}>{message}</p>

              <form onSubmit={resend} style={{ textAlign: 'left' }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 }}>Resend the link to your email</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" required />
                  <button disabled={busy} style={{ padding: '0 18px', background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1, whiteSpace: 'nowrap' }}>
                    {busy ? 'Sending…' : 'Resend'}
                  </button>
                </div>
              </form>
              {resendMsg && (
                <div style={{ marginTop: 14, fontSize: 13, color: '#15803D', fontWeight: 600 }}>{resendMsg}</div>
              )}
            </>
          )}

          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Link to="/" style={{ color: '#1F4E9E', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to website
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

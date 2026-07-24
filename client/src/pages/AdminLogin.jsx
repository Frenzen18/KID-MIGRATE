import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

/**
 * Administrator sign-in, deliberately unlinked from every public page.
 * Reachable only by typing /admin/login directly. Minimal by design: no
 * signup, no Google sign-in, no public password-reset. The only outbound
 * links are to the other internal-role logins (staff/therapist), grouped
 * here together rather than on the public parent login.
 */
export default function AdminLogin() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const u = await login(email.trim(), password, 'admin');
      nav(u.must_change_password ? '/set-password' : '/admin');
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  const input = {
    width: '100%', padding: '13px 15px', border: '1px solid #2E3A50', borderRadius: 8,
    fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none',
    background: '#141B29', color: '#E6EAF2', boxSizing: 'border-box'
  };
  const label = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#8A94A8', marginBottom: 8, letterSpacing: '.04em', textTransform: 'uppercase' };

  return (
    <div style={{ minHeight: '100vh', background: '#0B1120', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Inter,sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: 'var(--color-landing-primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
            <i className="fa-solid fa-shield-halved" style={{ color: '#fff', fontSize: 24 }} />
          </div>
          <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 22, fontWeight: 600, color: '#E6EAF2' }}>KID Clinic Administration</div>
          <div style={{ fontSize: 12.5, color: '#8A94A8', marginTop: 6 }}>Authorized personnel only</div>
        </div>

        <div style={{ background: '#101828', border: '1px solid #1E293B', borderRadius: 14, padding: '32px 30px' }}>
          {err && (
            <div style={{ background: 'rgba(196,48,43,.12)', border: '1px solid rgba(196,48,43,.4)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#F87171', marginBottom: 18, fontWeight: 600 }}>
              <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
            </div>
          )}

          <form onSubmit={submit}>
            <div style={{ marginBottom: 18 }}>
              <label style={label}>Email</label>
              <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required />
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={label}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  style={{ ...input, paddingRight: 42 }}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: '#5B6579', display: 'flex', alignItems: 'center' }}
                >
                  <i className={'fa-solid ' + (showPw ? 'fa-eye-slash' : 'fa-eye')} style={{ fontSize: 15 }} />
                </button>
              </div>
            </div>
            <button disabled={busy} style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1 }}>
              {busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>

        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 12, color: '#5B6579', lineHeight: 1.6 }}>
          Access is restricted and monitored. Forgot your password?<br />Contact another administrator.
        </div>

        <div style={{ textAlign: 'center', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Link to="/staff/login" style={{ color: '#8A94A8', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>Are you a staff member? Sign in here →</Link>
          <Link to="/therapist/login" style={{ color: '#8A94A8', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>Are you a therapist? Sign in here →</Link>
        </div>
      </div>
    </div>
  );
}

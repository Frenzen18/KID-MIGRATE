import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { HOME_FOR_ROLE } from '../App.jsx';
import AuthLeftPanel from './AuthLeftPanel.jsx';

/**
 * Shared sign-in card used by the parent, staff, and therapist login pages,  * they only differ in icon/title/subtitle, which portal to authenticate
 * against, and the small "switch to a different sign-in" footer link.
 * AdminLogin intentionally stays separate (different dark theme, no public
 * links, no signup/forgot-password) since it's a deliberately distinct,
 * unlinked door, see the comment on AdminLogin.jsx.
 */
export default function AuthCard({
  icon,
  iconSize = 40,
  eyebrow,           // e.g. "Staff Portal", shown under the KID wordmark
  title,              // e.g. "Welcome back"
  subtitle,           // helper copy under the title
  portal,             // 3rd arg to login(email, password, portal), undefined for the default parent flow
  fallbackHome = '/portal',
  showSignupLink = false,
  footerLink          // optional { to, label } for "Staff sign-in instead →" etc.
}) {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setNeedsVerification(false);
    setBusy(true);
    try {
      const u = await login(email.trim(), password, portal);
      nav(u.must_change_password ? '/set-password' : (HOME_FOR_ROLE[u.role] || fallbackHome));
    } catch (ex) {
      setErr(ex.message);
      if (ex.data?.needsVerification) setNeedsVerification(true);
    } finally {
      setBusy(false);
    }
  }

  const input = { width: '100%', padding: '12px 15px', border: '1px solid var(--color-border)', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff' };
  const label = { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 };

  return (
    <div className="login-body">
      <div className="login-card">
        <AuthLeftPanel icon={icon} iconSize={iconSize} eyebrow={eyebrow} />
        <div style={{ padding: '48px 44px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>{title}</div>
          <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>{subtitle}</p>

          {err && (
            <div className="auth-alert-in" style={{ background: 'var(--color-danger-bg-soft)', border: '1px solid var(--color-danger-bg)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
              <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
              {needsVerification && (
                <div style={{ marginTop: 8 }}>
                  <Link to={`/verify-email?email=${encodeURIComponent(email.trim())}`} style={{ color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 700, textDecoration: 'underline' }}>
                    Verify your email now
                  </Link>
                </div>
              )}
            </div>
          )}

          <form onSubmit={submit}>
            <div style={{ marginBottom: 18 }}>
              <label style={label}>Email Address</label>
              <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@kidclinic.ph" autoComplete="username" required />
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={label}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  style={{ ...input, paddingRight: 42 }}
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPw(s => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: 'var(--color-text-faint)', display: 'flex', alignItems: 'center' }}
                >
                  <i className={'fa-solid ' + (showPw ? 'fa-eye-slash' : 'fa-eye')} style={{ fontSize: 15 }} />
                </button>
              </div>
              <div style={{ textAlign: 'right', marginTop: 8 }}>
                <Link to="/forgot-password" style={{ fontSize: 12.5, color: 'var(--color-landing-primary)', fontWeight: 600, textDecoration: 'none' }}>Forgot Password?</Link>
              </div>
            </div>
            <button disabled={busy} className="auth-submit-btn" style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? .8 : 1 }}>
              {busy && <span className="auth-spinner" />}{busy ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          {showSignupLink && (
            <div style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: 'var(--color-text-muted)' }}>
              Parent or guardian and new here?{' '}
              <Link to="/signup" style={{ color: 'var(--color-landing-primary)', fontWeight: 700, textDecoration: 'none' }}>Create an account</Link>
            </div>
          )}

          {footerLink && (
            <div style={{ textAlign: 'center', marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(Array.isArray(footerLink) ? footerLink : [footerLink]).map((fl, i) => (
                <Link key={i} to={fl.to} style={{ color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>{fl.label}</Link>
              ))}
            </div>
          )}

          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <Link to="/" style={{ color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to website
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

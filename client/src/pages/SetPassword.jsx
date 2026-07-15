import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { HOME_FOR_ROLE } from '../App.jsx';

/**
 * Forced first-login password set-up. Shown right after a successful login
 * when the account still has must_change_password set (i.e. it was created
 * by an admin with a temporary password). The user must re-enter that
 * temporary password plus a new one before reaching their portal.
 */
export default function SetPassword() {
  const { user, changePassword, logout } = useAuth();
  const nav = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (newPassword !== confirmPassword) {
      setErr('New password and confirmation do not match.');
      return;
    }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setErr('New password must be at least 8 characters with letters and numbers.');
      return;
    }
    if (newPassword === currentPassword) {
      setErr('New password must be different from your temporary password.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      nav(HOME_FOR_ROLE[user?.role] || '/portal', { replace: true });
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  const input = { width: '100%', padding: '12px 15px', border: '1px solid var(--color-border)', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff' };
  const label = { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 };

  return (
    <div className="login-body">
      <div className="login-card">
        <div className="login-left">
          <div style={{ width: 96, height: 96, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <i className="fa-solid fa-key" style={{ color: '#fff', fontSize: 40 }} />
          </div>
          <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 30, fontWeight: 600, color: '#fff' }}>KID</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,.7)', letterSpacing: '.05em', textTransform: 'uppercase', fontWeight: 600, lineHeight: 1.6 }}>
            Pediatric Speech &amp;<br />Occupational Therapy Clinic
          </div>
          <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.5)', lineHeight: 1.7, marginTop: 24 }}>
            Bloomsdale Therapy Center<br />Imus, Cavite · LPU-Cavite CITCS
          </div>
        </div>
        <div style={{ padding: '48px 44px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Set your password</div>
          <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
            Your account was created with a temporary password. For your security, please set a new password before continuing.
          </p>

          {err && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
              <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
            </div>
          )}

          <form onSubmit={submit}>
            <div style={{ marginBottom: 18 }}>
              <label style={label}>Temporary Password</label>
              <input
                style={input}
                type={showPw ? 'text' : 'password'}
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="The password you were given"
                autoComplete="current-password"
                required
              />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={label}>New Password</label>
              <input
                style={input}
                type={showPw ? 'text' : 'password'}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Min. 8 characters, letters and numbers"
                autoComplete="new-password"
                required
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={label}>Confirm New Password</label>
              <input
                style={input}
                type={showPw ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Re-enter your new password"
                autoComplete="new-password"
                required
              />
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={{ fontSize: 12.5, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showPw} onChange={e => setShowPw(e.target.checked)} />
                Show passwords
              </label>
            </div>
            <button disabled={busy} style={{ width: '100%', padding: 13, background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1 }}>
              {busy ? 'Setting password…' : 'Set Password & Continue'}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <button
              type="button"
              onClick={() => { logout(); nav('/login'); }}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-text-muted)', fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

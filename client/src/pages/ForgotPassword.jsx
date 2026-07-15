import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function ForgotPassword() {
  const nav = useNavigate();
  const [step, setStep] = useState(1); // 1: email, 2: code, 3: new password
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function sendCode(e) {
    e.preventDefault();
    setErr('');
    if (!email.trim()) return setErr('Please enter your email address.');
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email: email.trim() } });
      setStep(2);
    } catch (ex) {
      setErr(ex.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(e) {
    e.preventDefault();
    setErr('');
    if (!code.trim() || code.trim().length !== 6) return setErr('Please enter the 6-digit code.');
    setBusy(true);
    try {
      await api('/auth/verify-reset-code', { method: 'POST', body: { email: email.trim(), code: code.trim() } });
      setStep(3);
    } catch (ex) {
      setErr(ex.message || 'Invalid code.');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(e) {
    e.preventDefault();
    setErr('');
    if (newPassword.length < 8) return setErr('Password must be at least 8 characters.');
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return setErr('Password must contain both letters and numbers.');
    if (newPassword !== confirmPassword) return setErr('Passwords do not match.');
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { email: email.trim(), code: code.trim(), newPassword } });
      setStep(4); // success
    } catch (ex) {
      setErr(ex.message || 'Failed to reset password.');
    } finally {
      setBusy(false);
    }
  }

  const input = { width: '100%', padding: '14px 16px', border: '1.5px solid var(--color-border)', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box', transition: 'border-color .2s' };
  const label = { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 };

  return (
    <div className="login-body">
      <div className="login-card" style={{ gridTemplateColumns: '360px 440px' }}>
        <div className="login-left">
          <div style={{ width: 96, height: 96, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <i className="fa-solid fa-child-reaching" style={{ color: '#fff', fontSize: 40 }} />
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

          {/* Step 1: Enter email */}
          {step === 1 && (
            <>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Reset your password</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
                Enter the email address linked to your account. We'll send you a 6-digit code to reset your password.
              </p>

              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
                </div>
              )}

              <form onSubmit={sendCode}>
                <div style={{ marginBottom: 22 }}>
                  <label style={label}>Email Address</label>
                  <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" required />
                </div>
                <button disabled={busy} style={{ width: '100%', padding: 13, background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1 }}>
                  {busy ? 'Sending…' : 'Send Reset Code'}
                </button>
              </form>
            </>
          )}

          {/* Step 2: Enter code */}
          {step === 2 && (
            <>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Enter reset code</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
                If <strong>{email}</strong> is registered with us, a 6-digit code is on its way. Check your inbox (and spam folder) and enter it below.
              </p>

              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
                </div>
              )}

              <form onSubmit={verifyCode}>
                <div style={{ marginBottom: 22 }}>
                  <label style={label}>6-Digit Code</label>
                  <input
                    style={{ ...input, fontSize: 24, letterSpacing: 8, textAlign: 'center', fontWeight: 700 }}
                    type="text"
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    required
                  />
                </div>
                <button disabled={busy || code.length !== 6} style={{ width: '100%', padding: 13, background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: (busy || code.length !== 6) ? .7 : 1 }}>
                  {busy ? 'Verifying…' : 'Verify Code'}
                </button>
              </form>

              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button onClick={() => { setErr(''); sendCode({ preventDefault: () => {} }); }} style={{ background: 'none', border: 'none', color: '#1F4E9E', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Didn't receive it? Resend code
                </button>
              </div>
            </>
          )}

          {/* Step 3: Set new password */}
          {step === 3 && (
            <>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Set new password</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
                Choose a strong new password for your account.
              </p>

              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
                </div>
              )}

              <form onSubmit={resetPassword}>
                <div style={{ marginBottom: 18 }}>
                  <label style={label}>New Password</label>
                  <input style={input} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Min. 8 chars, letters & numbers" required />
                </div>
                <div style={{ marginBottom: 22 }}>
                  <label style={label}>Confirm New Password</label>
                  <input style={input} type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter password" required />
                </div>
                <button disabled={busy} style={{ width: '100%', padding: 13, background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1 }}>
                  {busy ? 'Resetting…' : 'Reset Password'}
                </button>
              </form>
            </>
          )}

          {/* Step 4: Success */}
          {step === 4 && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#DCFCE7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <i className="fa-solid fa-check" style={{ fontSize: 28, color: '#16A34A' }} />
              </div>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 22, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 10 }}>Password reset!</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.6, marginBottom: 24 }}>
                Your password has been successfully changed. You can now sign in with your new password.
              </p>
              <button onClick={() => nav('/login')} style={{ width: '100%', padding: 13, background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                Go to Sign In
              </button>
            </div>
          )}

          {step !== 4 && (
            <div style={{ textAlign: 'center', marginTop: 24 }}>
              <Link to="/login" style={{ color: '#1F4E9E', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to Sign In
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import PasswordChecklist, { passwordMeetsPolicy } from '../components/PasswordChecklist.jsx';
import AuthLeftPanel from '../components/AuthLeftPanel.jsx';
import { formatPhoneDisplay } from '../phoneInput.js';
import { useToast } from '../components/ui.jsx';

export default function ForgotPassword() {
  const nav = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(1); // 1: identifier, 2: code, 3: new password
  // Most guardians reset by mobile number (some have no email at all, see
  // signup's phoneOnly path), so default to a phone-style input with +63
  // pre-filled, same as Login's AuthCard, with a link to switch to email.
  const [identifier, setIdentifier] = useState('+63');
  const [useEmail, setUseEmail] = useState(false);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const phoneMode = !useEmail;
  // No "@" only ever means a phone number in this app's two identifier types.
  const isPhone = !identifier.includes('@');

  function switchToEmail() { setUseEmail(true); setIdentifier(''); setErr(''); }
  function switchToPhone() { setUseEmail(false); setIdentifier('+63'); setErr(''); }
  function onPhoneChange(e) {
    const raw = e.target.value.replace(/\s+/g, '');
    const rest = raw.startsWith('+63') ? raw.slice(3) : raw.replace(/^\+?6?3?/, '');
    setIdentifier('+63' + rest.replace(/\D/g, '').slice(0, 10));
  }

  async function sendCode(e) {
    e.preventDefault();
    setErr('');
    if (phoneMode && identifier === '+63') return setErr('Please enter your mobile number.');
    if (!identifier.trim()) return setErr('Please enter your email address or mobile number.');
    setBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { identifier: identifier.trim() } });
      setStep(2);
    } catch (ex) {
      setErr(ex.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Separate from sendCode: step is already 2 by the time this is reachable,
  // so setStep(2) there is a no-op, nothing on screen changes to confirm it
  // actually went out, this shows an explicit toast instead.
  async function resendCode() {
    setErr('');
    setResendBusy(true);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { identifier: identifier.trim() } });
      toast('Code resent' + (isPhone ? ' by SMS' : ' by email'), 'fa-paper-plane');
    } catch (ex) {
      setErr(ex.message || 'Failed to resend the code. Please try again.');
    } finally {
      setResendBusy(false);
    }
  }

  async function verifyCode(e) {
    e.preventDefault();
    setErr('');
    if (!code.trim() || code.trim().length !== 6) return setErr('Please enter the 6-digit code.');
    setBusy(true);
    try {
      await api('/auth/verify-reset-code', { method: 'POST', body: { identifier: identifier.trim(), code: code.trim() } });
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
    if (!passwordMeetsPolicy(newPassword)) return setErr('Password does not meet all the requirements below.');
    if (newPassword !== confirmPassword) return setErr('Passwords do not match.');
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { identifier: identifier.trim(), code: code.trim(), newPassword } });
      setStep(4); // success
    } catch (ex) {
      setErr(ex.message || 'Failed to reset password.');
    } finally {
      setBusy(false);
    }
  }

  const input = { width: '100%', padding: '14px 16px', border: '1.5px solid var(--color-border)', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box', transition: 'border-color .2s' };
  const label = { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 };

  function eyeToggle(shown, setShown) {
    return (
      <button
        type="button"
        onClick={() => setShown(s => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: '#9AA0AE', display: 'flex', alignItems: 'center' }}
      >
        <i className={'fa-solid ' + (shown ? 'fa-eye-slash' : 'fa-eye')} style={{ fontSize: 15 }} />
      </button>
    );
  }

  return (
    <div className="login-body">
      <div className="login-card" style={{ gridTemplateColumns: '360px 440px' }}>
        <AuthLeftPanel icon="fa-child-reaching" iconSize={40} eyebrow={<>Pediatric Speech &amp;<br />Occupational Therapy Clinic</>} />
        <div style={{ padding: '48px 44px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>

          {/* Step 1: Enter email */}
          {step === 1 && (
            <>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Reset your password</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
                Enter the email address or mobile number linked to your account. We'll send you a 6-digit code to reset your password.
              </p>

              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
                </div>
              )}

              <form onSubmit={sendCode}>
                <div style={{ marginBottom: 22 }}>
                  <label style={label}>{phoneMode ? 'Mobile Number' : 'Email Address'}</label>
                  {phoneMode ? (
                    <input style={input} type="tel" value={formatPhoneDisplay(identifier)} onChange={onPhoneChange} placeholder="+63 000 000 0000" required />
                  ) : (
                    <input style={input} type="text" value={identifier} onChange={e => setIdentifier(e.target.value)} placeholder="you@kidclinic.ph" required />
                  )}
                  <div style={{ textAlign: 'right', marginTop: 6 }}>
                    <button type="button" onClick={phoneMode ? switchToEmail : switchToPhone} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--color-landing-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      {phoneMode ? 'Reset with email instead' : 'Reset with mobile number instead'}
                    </button>
                  </div>
                </div>
                <button className="auth-submit-btn" disabled={busy} style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1 }}>
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
                If <strong>{identifier}</strong> is registered with us, a 6-digit code is on its way.{' '}
                {isPhone ? 'Check your phone for a text message and enter it below.' : 'Check your inbox (and spam folder) and enter it below.'}
              </p>

              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
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
                <button className="auth-submit-btn" disabled={busy || code.length !== 6} style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: (busy || code.length !== 6) ? .7 : 1 }}>
                  {busy ? 'Verifying…' : 'Verify Code'}
                </button>
              </form>

              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button onClick={resendCode} disabled={resendBusy} style={{ background: 'none', border: 'none', color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 600, cursor: resendBusy ? 'default' : 'pointer', opacity: resendBusy ? .7 : 1 }}>
                  {resendBusy ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Resending…</> : "Didn't receive it? Resend code"}
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
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
                </div>
              )}

              <form onSubmit={resetPassword}>
                <div style={{ marginBottom: 18 }}>
                  <label style={label}>New Password</label>
                  <div style={{ position: 'relative' }}>
                    <input style={{ ...input, paddingRight: 40 }} type={showPw ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Create a password" required />
                    {eyeToggle(showPw, setShowPw)}
                  </div>
                  <PasswordChecklist password={newPassword} />
                </div>
                <div style={{ marginBottom: 22 }}>
                  <label style={label}>Confirm New Password</label>
                  <div style={{ position: 'relative' }}>
                    <input style={{ ...input, paddingRight: 40 }} type={showConfirm ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter password" required />
                    {eyeToggle(showConfirm, setShowConfirm)}
                  </div>
                </div>
                <button className="auth-submit-btn" disabled={busy} style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1 }}>
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
              <button className="auth-submit-btn" onClick={() => nav('/login')} style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                Go to Sign In
              </button>
            </div>
          )}

          {step !== 4 && (
            <div style={{ textAlign: 'center', marginTop: 24 }}>
              <Link to="/login" style={{ color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to Sign In
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

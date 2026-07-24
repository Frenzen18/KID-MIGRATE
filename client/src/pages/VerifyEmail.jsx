import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import AuthLeftPanel from '../components/AuthLeftPanel.jsx';

/**
 * Email verification, code-based (mirrors ForgotPassword's flow): the
 * signup/resend endpoints email a 6-digit code instead of a link, and this
 * page collects it. Reached either with a known email (from Signup's
 * navigate state, or a ?email= query param from the "verify now" prompt on
 * a blocked login) or blank, in which case the user types their email first.
 */
export default function VerifyEmail() {
  const nav = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const stateEmail = location.state?.email || '';
  const queryEmail = params.get('email') || '';
  const initialEmail = stateEmail || queryEmail;

  const [step, setStep] = useState(initialEmail ? 'code' : 'email'); // email | code | success
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

  // Signup already sends the first code as part of account creation, so
  // don't fire a second one when arriving with state from that flow, only
  // when landing here directly (e.g. the query-param link from a blocked login).
  const autoSent = useRef(!!stateEmail);

  useEffect(() => {
    if (!queryEmail || autoSent.current) return;
    autoSent.current = true;
    api('/auth/resend-verification', { method: 'POST', body: { email: queryEmail } }).catch(() => {});
  }, [queryEmail]);

  async function sendCode(e) {
    e.preventDefault();
    setErr('');
    if (!email.trim()) return setErr('Please enter your email address.');
    setBusy(true);
    try {
      await api('/auth/resend-verification', { method: 'POST', body: { email: email.trim() } });
      setStep('code');
    } catch (ex) {
      setErr(ex.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    setErr('');
    setResendMsg('');
    try {
      const r = await api('/auth/resend-verification', { method: 'POST', body: { email: email.trim() } });
      setResendMsg(r.message || 'A new code has been sent.');
    } catch (ex) {
      setErr(ex.message);
    }
  }

  async function verifyCode(e) {
    e.preventDefault();
    setErr('');
    if (!code.trim() || code.trim().length !== 6) return setErr('Please enter the 6-digit code.');
    setBusy(true);
    try {
      await api('/auth/verify-email', { method: 'POST', body: { email: email.trim(), code: code.trim() } });
      setStep('success');
    } catch (ex) {
      setErr(ex.message || 'Invalid code.');
    } finally {
      setBusy(false);
    }
  }

  const input = { width: '100%', padding: '14px 16px', border: '1.5px solid var(--color-border)', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box', transition: 'border-color .2s' };
  const label = { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 8 };

  return (
    <div className="login-body">
      <div className="login-card" style={{ gridTemplateColumns: '360px 440px' }}>
        <AuthLeftPanel icon="fa-child-reaching" iconSize={40} eyebrow={<>Pediatric Speech &amp;<br />Occupational Therapy Clinic</>} />
        <div style={{ padding: '48px 44px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>

          {/* Step: enter email (only when we don't already know it) */}
          {step === 'email' && (
            <>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Verify your email</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
                Enter the email address on your account. We'll send you a 6-digit code to verify it.
              </p>

              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
                </div>
              )}

              <form onSubmit={sendCode}>
                <div style={{ marginBottom: 22 }}>
                  <label style={label}>Email Address</label>
                  <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" required />
                </div>
                <button className="auth-submit-btn" disabled={busy} style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer', opacity: busy ? .7 : 1 }}>
                  {busy ? 'Sending…' : 'Send Verification Code'}
                </button>
              </form>
            </>
          )}

          {/* Step: enter code */}
          {step === 'code' && (
            <>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Enter verification code</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
                We sent a 6-digit code to <strong>{email}</strong>. Check your inbox (and spam folder) and enter it below.
              </p>

              {err && (
                <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
                  <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
                </div>
              )}
              {resendMsg && (
                <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#15803D', marginBottom: 16, fontWeight: 600 }}>
                  {resendMsg}
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
                  {busy ? 'Verifying…' : 'Verify Email'}
                </button>
              </form>

              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <button onClick={resendCode} style={{ background: 'none', border: 'none', color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Didn't receive it? Resend code
                </button>
              </div>
            </>
          )}

          {/* Step: success */}
          {step === 'success' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#DCFCE7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <i className="fa-solid fa-check" style={{ fontSize: 28, color: '#16A34A' }} />
              </div>
              <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 22, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 10 }}>Email verified!</div>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.6, marginBottom: 24 }}>
                Your account is now active. You can sign in to the parent portal.
              </p>
              <button className="auth-submit-btn" onClick={() => nav('/login')} style={{ width: '100%', padding: 13, background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                Go to Sign In
              </button>
            </div>
          )}

          {step !== 'success' && (
            <div style={{ textAlign: 'center', marginTop: 24 }}>
              <Link to="/" style={{ color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
                <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to website
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

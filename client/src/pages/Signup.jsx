import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';

/**
 * Self-service registration, parents/guardians only. Every account
 * created here is provisioned with role "parent"; staff/therapist/admin
 * accounts are still created by an administrator in the User Management
 * module, not through this public form.
 */

/** 0–4: length + character variety. Simple heuristic, scored live as the user types. */
function passwordScore(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(pw)).length;
  if (variety >= 2) score++;
  if (variety >= 3 && pw.length >= 10) score++;
  return score;
}

const STRENGTH = [
  { label: 'Too short', color: 'var(--color-danger)' },
  { label: 'Weak', color: 'var(--color-danger)' },
  { label: 'Fair', color: 'var(--color-warning)' },
  { label: 'Good', color: 'var(--color-teal-dark)' },
  { label: 'Strong', color: 'var(--color-success)' }
];

function StrengthMeter({ password }) {
  if (!password) return null;
  const score = passwordScore(password);
  const { label, color } = STRENGTH[score];
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= score ? color : '#E5E7EB', transition: 'background .2s' }} />
        ))}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color, marginTop: 5 }}>{label}</div>
    </div>
  );
}
// Philippine mobile number: +639XXXXXXXXX only
const PH_PHONE = /^\+639\d{9}$/;

export default function Signup() {
  const { signup } = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [contact, setContact] = useState('+63');
  const [contactNote, setContactNote] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);

  // After a successful signup we show the "check your email" screen instead of the form.
  const [awaitingVerify, setAwaitingVerify] = useState(null); // { email, emailSent }
  const [cooldown, setCooldown] = useState(0);
  const [resendMsg, setResendMsg] = useState('');

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function submit(e) {
    e.preventDefault();
    setErr('');

    if (!firstName.trim() || !lastName.trim()) return setErr('First name and last name are required.');
    const contactVal = contact === '+63' ? '' : contact;
    if (contactVal && !PH_PHONE.test(contactVal)) return setErr('Contact number must be +63 followed by 10 digits (e.g. +639171234567).');
    if (password.length < 8) return setErr('Password must be at least 8 characters.');
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return setErr('Password must contain both letters and numbers.');
    if (password !== confirm) return setErr('Passwords do not match.');
    if (!agreed) return setErr('Please read and agree to the Data Privacy Notice first.');

    setBusy(true);
    try {
      const result = await signup({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), password, contact: contactVal });
      setAwaitingVerify({ email: result.email || email.trim(), emailSent: result.emailSent !== false });
      setCooldown(10); // TESTING: 10s, prod: 60
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setResendMsg('');
    try {
      const r = await api('/auth/resend-verification', { method: 'POST', body: { email: awaitingVerify.email } });
      setResendMsg(r.message || 'A new link has been sent.');
      setCooldown(10); // TESTING: 10s, prod: 60
    } catch (ex) {
      setResendMsg(ex.message);
    }
  }

  const input = { width: '100%', padding: '14px 16px', border: '1.5px solid var(--color-border)', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box', transition: 'border-color .2s' };
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
      <div className="login-card" style={{ gridTemplateColumns: '340px 1fr', maxWidth: 820 }}>
        <div className="login-left">
          <div className="login-icon-ring" style={{ width: 96, height: 96, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
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
        {awaitingVerify ? (
        <div className="auth-fade-in" style={{ padding: '40px 48px', display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
          <div className="auth-pop-in" style={{ width: 72, height: 72, borderRadius: '50%', background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <i className="fa-solid fa-envelope-open-text" style={{ color: '#1F4E9E', fontSize: 30 }} />
          </div>
          <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 10 }}>Check your email</div>
          <p style={{ fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.7, marginBottom: 6 }}>
            {awaitingVerify.emailSent
              ? <>We sent a verification link to <strong style={{ color: 'var(--color-ink)' }}>{awaitingVerify.email}</strong>.<br />Click the link in the email to activate your account, then sign in.</>
              : <>Your account was created, but we couldn't send the verification email to <strong style={{ color: 'var(--color-ink)' }}>{awaitingVerify.email}</strong>. Please use the resend button below.</>}
          </p>
          <p style={{ fontSize: 12.5, color: '#9AA0AE', marginBottom: 22 }}>The link expires in 24 hours. Don't forget to check your spam folder.</p>

          {resendMsg && (
            <div className="auth-alert-in" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#15803D', marginBottom: 16, fontWeight: 600 }}>
              {resendMsg}
            </div>
          )}

          <button
            onClick={resend}
            disabled={cooldown > 0}
            className="auth-submit-btn"
            style={{ width: '100%', padding: 13, background: cooldown > 0 ? '#E5E7EB' : '#1F4E9E', color: cooldown > 0 ? '#9AA0AE' : '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: cooldown > 0 ? 'default' : 'pointer' }}
          >
            {cooldown > 0 ? `Resend email (${cooldown}s)` : 'Resend verification email'}
          </button>

          <div style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: 'var(--color-text-muted)' }}>
            Already verified?{' '}
            <Link to="/login" style={{ color: '#1F4E9E', fontWeight: 700, textDecoration: 'none' }}>Sign in</Link>
          </div>
        </div>
        ) : (
        <div style={{ padding: '40px 48px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 26, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>Create your account</div>
          <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 24, lineHeight: 1.6 }}>
            For parents and guardians, register to book sessions, follow your child's progress, and manage payments.
          </p>

          {err && (
            <div className="auth-alert-in" style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
              <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
            </div>
          )}

          <form onSubmit={submit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
              <div>
                <label style={label}>First Name</label>
                <input style={input} type="text" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Juan" required />
              </div>
              <div>
                <label style={label}>Last Name</label>
                <input style={input} type="text" value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Dela Cruz" required />
              </div>
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={label}>Email Address</label>
              <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" required />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={label}>Contact Number <span style={{ fontWeight: 400, color: '#9AA0AE' }}>(optional)</span></label>
              <input
                style={input}
                type="tel"
                value={contact}
                maxLength={13}
                onChange={e => {
                  const raw = e.target.value;
                  setContactNote(/[A-Za-z]/.test(raw) ? 'Numbers only, letters are not allowed.' : '');
                  const rest = raw.startsWith('+63') ? raw.slice(3) : raw.replace(/^\+?6?3?/, '');
                  const digits = rest.replace(/\D/g, '').slice(0, 10);
                  setContact(`+63${digits}`);
                }}
                placeholder="+639XXXXXXXXX"
              />
              {contactNote && <div style={{ fontSize: 12, color: 'var(--color-danger)', fontWeight: 600, marginTop: 5 }}>{contactNote}</div>}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 22 }}>
              <div>
                <label style={label}>Password</label>
                <div style={{ position: 'relative' }}>
                  <input style={{ ...input, paddingRight: 40 }} type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 8 chars, letters & numbers" required />
                  {eyeToggle(showPw, setShowPw)}
                </div>
                <StrengthMeter password={password} />
              </div>
              <div>
                <label style={label}>Confirm Password</label>
                <div style={{ position: 'relative' }}>
                  <input style={{ ...input, paddingRight: 40 }} type={showConfirm ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Re-enter password" required />
                  {eyeToggle(showConfirm, setShowConfirm)}
                </div>
              </div>
            </div>
            <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: '12px 14px', marginBottom: 18 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12.5, color: '#475569', cursor: 'pointer', lineHeight: 1.6 }}>
                <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 2, width: 15, height: 15, accentcolor: '#1F4E9E', cursor: 'pointer', flexShrink: 0 }} />
                <span>
                  I agree to the <strong>Data Privacy Notice</strong>: KID Clinic collects my name, email, and contact number solely to manage my account and my child's therapy services, keeps them confidential in accordance with the <strong>Data Privacy Act of 2012 (RA 10173)</strong>, and never shares them with third parties. I may request to view, correct, or delete my information at any time.
                </span>
              </label>
            </div>
            <button disabled={busy || !agreed} className="auth-submit-btn" style={{ width: '100%', padding: 13, background: (busy || !agreed) ? '#CBD5E1' : '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: (busy || !agreed) ? 'default' : 'pointer' }}>
              {busy && <span className="auth-spinner" />}{busy ? 'Creating account…' : 'Create Account'}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: 20, fontSize: 13, color: 'var(--color-text-muted)' }}>
            Already have an account?{' '}
            <Link to="/login" style={{ color: '#1F4E9E', fontWeight: 700, textDecoration: 'none' }}>Sign in</Link>
          </div>

          <div style={{ textAlign: 'center', marginTop: 14 }}>
            <Link to="/" style={{ color: '#1F4E9E', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to website
            </Link>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

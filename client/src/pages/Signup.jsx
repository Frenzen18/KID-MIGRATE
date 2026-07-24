import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Modal } from '../components/ui.jsx';
import PasswordChecklist, { passwordMeetsPolicy } from '../components/PasswordChecklist.jsx';
import AuthLeftPanel from '../components/AuthLeftPanel.jsx';
import { formatPhoneDisplay } from '../phoneInput.js';
import { sanitizeNameInput, hasInvalidNameChars, INVALID_NAME_MSG } from '../nameInput.js';

/**
 * Self-service registration, parents/guardians only. Every account
 * created here is provisioned with role "parent"; staff/therapist/admin
 * accounts are still created by an administrator in the User Management
 * module, not through this public form.
 */

// Philippine mobile number: +639XXXXXXXXX only
const PH_PHONE = /^\+639\d{9}$/;

export default function Signup() {
  const { signup } = useAuth();
  const nav = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [firstNameNote, setFirstNameNote] = useState('');
  const [lastNameNote, setLastNameNote] = useState('');
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
  const [openNotice, setOpenNotice] = useState(null); // 'privacy' | 'terms' | null
  // Must actually open and read both notices before the agreement checkbox
  // becomes checkable, clicking either link marks it viewed.
  const [viewedPrivacy, setViewedPrivacy] = useState(false);
  const [viewedTerms, setViewedTerms] = useState(false);
  const canAgree = viewedPrivacy && viewedTerms;

  async function submit(e) {
    e.preventDefault();
    setErr('');

    if (!firstName.trim() || !lastName.trim()) return setErr('First name and last name are required.');
    const contactVal = contact === '+63' ? '' : contact;
    if (!contactVal) return setErr('Contact number is required.');
    if (!PH_PHONE.test(contactVal)) return setErr('Contact number must be +63 followed by 10 digits (e.g. +63 917 123 4567).');
    if (!passwordMeetsPolicy(password)) return setErr('Password does not meet all the requirements below.');
    if (password !== confirm) return setErr('Passwords do not match.');
    if (!agreed) return setErr('Please agree to the Data Privacy Notice and Terms of Use first.');

    setBusy(true);
    try {
      const result = await signup({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), password, contact: contactVal });
      nav('/verify-email', { state: { email: result.email || email.trim() } });
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  const input = { width: '100%', padding: '10px 16px', border: '1.5px solid var(--color-border)', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 14, outline: 'none', background: '#fff', boxSizing: 'border-box', transition: 'border-color .2s' };
  const label = { display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 5 };
  const noticeLinkStyle = { background: 'none', border: 'none', padding: 0, margin: 0, font: 'inherit', color: 'var(--color-landing-primary)', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' };

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
    <>
    <div className="login-body">
      <div className="login-card" style={{ gridTemplateColumns: '340px 1fr', maxWidth: 820 }}>
        <AuthLeftPanel icon="fa-child-reaching" iconSize={40} eyebrow={<>Pediatric Speech &amp;<br />Occupational Therapy Clinic</>} />
        <div style={{ padding: '20px 48px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 24, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 6 }}>Create your account</div>
          <p style={{ fontSize: 13.5, color: 'var(--color-text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
            For parents and guardians, register to book sessions, follow your child's progress, and manage payments.
          </p>

          {err && (
            <div className="auth-alert-in" style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--color-danger)', marginBottom: 16, fontWeight: 600 }}>
              <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}
            </div>
          )}

          <form onSubmit={submit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 9 }}>
              <div>
                <label style={label}>First Name</label>
                <input style={input} type="text" value={firstName} onChange={e => {
                  setFirstNameNote(hasInvalidNameChars(e.target.value) ? INVALID_NAME_MSG : '');
                  setFirstName(sanitizeNameInput(e.target.value));
                }} placeholder="Juan" required />
                {firstNameNote && <div style={{ fontSize: 12, color: 'var(--color-danger)', fontWeight: 600, marginTop: 5 }}>{firstNameNote}</div>}
              </div>
              <div>
                <label style={label}>Last Name</label>
                <input style={input} type="text" value={lastName} onChange={e => {
                  setLastNameNote(hasInvalidNameChars(e.target.value) ? INVALID_NAME_MSG : '');
                  setLastName(sanitizeNameInput(e.target.value));
                }} placeholder="Dela Cruz" required />
                {lastNameNote && <div style={{ fontSize: 12, color: 'var(--color-danger)', fontWeight: 600, marginTop: 5 }}>{lastNameNote}</div>}
              </div>
            </div>
            <div style={{ marginBottom: 9 }}>
              <label style={label}>Email Address</label>
              <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" required />
            </div>
            <div style={{ marginBottom: 9 }}>
              <label style={label}>Contact Number</label>
              <input
                style={input}
                type="tel"
                value={formatPhoneDisplay(contact)}
                maxLength={16}
                onChange={e => {
                  const raw = e.target.value;
                  setContactNote(/[A-Za-z]/.test(raw) ? 'Numbers only, letters are not allowed.' : '');
                  const rest = raw.startsWith('+63') ? raw.slice(3) : raw.replace(/^\+?6?3?/, '');
                  const digits = rest.replace(/\D/g, '').slice(0, 10);
                  setContact(`+63${digits}`);
                }}
                placeholder="+63 000 000 0000"
              />
              {contactNote && <div style={{ fontSize: 12, color: 'var(--color-danger)', fontWeight: 600, marginTop: 5 }}>{contactNote}</div>}
            </div>
            <div style={{ marginBottom: 9 }}>
              <label style={label}>Password</label>
              <div style={{ position: 'relative' }}>
                <input style={{ ...input, paddingRight: 40 }} type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Create a password" required />
                {eyeToggle(showPw, setShowPw)}
              </div>
              {password && <PasswordChecklist password={password} />}
            </div>
            <div style={{ marginBottom: 9 }}>
              <label style={label}>Confirm Password</label>
              <div style={{ position: 'relative' }}>
                <input style={{ ...input, paddingRight: 40 }} type={showConfirm ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Re-enter password" required />
                {eyeToggle(showConfirm, setShowConfirm)}
              </div>
              {confirm && confirm !== password && <div style={{ fontSize: 12, color: 'var(--color-danger)', fontWeight: 600, marginTop: 5 }}>Passwords do not match.</div>}
            </div>
            <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: '9px 14px', marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12.5, color: '#475569', cursor: canAgree ? 'pointer' : 'default', lineHeight: 1.6 }}>
                <input type="checkbox" checked={agreed} disabled={!canAgree} onChange={e => setAgreed(e.target.checked)} style={{ marginTop: 2, width: 15, height: 15, accentColor: 'var(--color-landing-primary)', cursor: canAgree ? 'pointer' : 'default', flexShrink: 0 }} />
                <span>
                  I agree to the{' '}
                  <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); setViewedPrivacy(true); setOpenNotice('privacy'); }} style={noticeLinkStyle}>Data Privacy Notice</button>
                  {' '}and{' '}
                  <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); setViewedTerms(true); setOpenNotice('terms'); }} style={noticeLinkStyle}>Terms of Use</button>.
                </span>
              </label>
              {!canAgree && (
                <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 6, paddingLeft: 25 }}>
                  <i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Open and review both the Data Privacy Notice and Terms of Use before you can agree.
                </div>
              )}
            </div>
            <button disabled={busy || !agreed} className="auth-submit-btn" style={{ width: '100%', padding: 11, background: (busy || !agreed) ? '#CBD5E1' : 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 10, fontFamily: 'Inter,sans-serif', fontSize: 15, fontWeight: 700, cursor: (busy || !agreed) ? 'default' : 'pointer' }}>
              {busy && <span className="auth-spinner" />}{busy ? 'Creating account…' : 'Create Account'}
            </button>
          </form>

          <div style={{ textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--color-text-muted)' }}>
            Already have an account?{' '}
            <Link to="/login" style={{ color: 'var(--color-landing-primary)', fontWeight: 700, textDecoration: 'none' }}>Sign in</Link>
          </div>

          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <Link to="/" style={{ color: 'var(--color-landing-primary)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to website
            </Link>
          </div>
        </div>
      </div>
    </div>

    {openNotice === 'privacy' && (
      <Modal title="Data Privacy Notice" onClose={() => setOpenNotice(null)} width={520}>
        <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.8 }}>
          <p style={{ margin: '0 0 12px' }}>Under the <strong>Data Privacy Act of 2012 (Republic Act 10173)</strong>:</p>
          <ul style={{ margin: '0 0 12px', paddingLeft: 18 }}>
            <li><strong>What we collect:</strong> your name, email, and contact number, and later your child's name, birthdate, and therapy-related information once you register them.</li>
            <li><strong>Why we collect it:</strong> solely to manage your account and provide pediatric speech and occupational therapy services, book sessions, and track your child's progress.</li>
            <li><strong>Who can see it:</strong> only authorized KID Clinic staff and your child's therapists. We never sell or share your information with third parties.</li>
            <li><strong>Your rights:</strong> you may request to view, correct, or delete your information at any time by contacting the clinic.</li>
          </ul>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button type="button" onClick={() => setOpenNotice(null)} style={{ padding: '10px 22px', background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Got it</button>
        </div>
      </Modal>
    )}

    {openNotice === 'terms' && (
      <Modal title="Terms of Use" onClose={() => setOpenNotice(null)} width={520}>
        <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.8 }}>
          <p style={{ margin: '0 0 12px' }}>By creating an account, you agree to:</p>
          <ul style={{ margin: '0 0 12px', paddingLeft: 18 }}>
            <li>Use this system only to manage your own account and your child's therapy services with KID Clinic.</li>
            <li>Provide accurate, truthful information when registering yourself and your child.</li>
            <li>Keep your login credentials confidential, you're responsible for activity under your account.</li>
            <li>Not misuse the system, this includes unauthorized access, sharing your account, or fraudulent bookings, doing so may lead to suspension.</li>
            <li>Follow the clinic's scheduling and cancellation policies when booking or managing sessions.</li>
          </ul>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button type="button" onClick={() => setOpenNotice(null)} style={{ padding: '10px 22px', background: 'var(--color-landing-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Got it</button>
        </div>
      </Modal>
    )}
    </>
  );
}

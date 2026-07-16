import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authClient, db } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizePhone } from '../phone.js';
import { sendMail } from '../mailer.js';
import { nextUserCode } from '../usercode.js';
import { passwordPolicyError } from '../validate.js';
import { logAudit } from '../lib/audit.js';
import { setCode, getCode, deleteCode } from '../codes.js';

const router = Router();

/* ── Rate limiting (per IP), slows brute force on passwords and reset codes ── */
function makeLimiter(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message })
  });
}
// Automatic by NODE_ENV, no manual step to remember before deploying.
// Set NODE_ENV=production (or PORT/hosting platform usually does this for you)
// to get the real windows; anything else gets short windows for local testing.
const isProd = process.env.NODE_ENV === 'production';
const MIN = 60 * 1000;
const loginLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 10, 'Too many login attempts. Please wait a while and try again.');
const adminLoginLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 5, 'Too many login attempts. Please wait a while and try again.');
const signupLimiter = makeLimiter(isProd ? 60 * MIN : 10 * 1000, 5, 'Too many signup attempts. Please wait a while and try again.');
const emailLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 5, 'Too many email requests. Please wait a while and try again.');
const codeLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 10, 'Too many attempts. Please wait a while and try again.');

/** Admin sign-ins get a stricter budget than the public portal. */
function loginRateLimit(req, res, next) {
  return (req.body?.portal === 'admin' ? adminLoginLimiter : loginLimiter)(req, res, next);
}

// (passwordPolicyError is imported from ../validate.js, shared with the users route)

// Codes (email verification + password reset) persist in the verification_codes
// table via ../codes.js, not server memory, so a restart doesn't invalidate a
// code someone is mid-flow entering. Resend cooldown is derived from each
// row's created_at instead of a separate timestamp map.
const VERIFY_CODE_TTL = 15 * 60 * 1000; // 15 minutes
const RESEND_COOLDOWN = 10 * 1000; // TESTING: 10 seconds, prod: 60 * 1000

// (sendMail is imported from ../mailer.js, single shared, explicit-TLS transporter)

function verificationCodeEmailHtml(fullName, code) {
  return `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
        <p style="color: #64748B; font-size: 13px;">Pediatric Speech & Occupational Therapy</p>
      </div>
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px; text-align: center;">
        <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${fullName || 'there'},</p>
        <p style="color: #64748B; font-size: 13px; margin: 0 0 20px;">Welcome to KID Clinic! Use this code to verify your email and activate your account. It expires in 15 minutes.</p>
        <div style="background: #1F4E9E; color: #fff; font-size: 32px; font-weight: 700; letter-spacing: 8px; padding: 16px 24px; border-radius: 8px; display: inline-block;">${code}</div>
        <p style="color: #94A3B8; font-size: 12px; margin: 20px 0 0;">If you didn't create this account, please ignore this email.</p>
      </div>
    </div>
  `;
}

/** Creates a fresh 6-digit verification code for the user and emails it. */
async function sendVerificationEmail({ userId, email, fullName }) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await sendMail({
    to: email,
    subject: 'Verify your email: KID Clinic',
    html: verificationCodeEmailHtml(fullName, code)
  });
  await setCode({ email, purpose: 'email_verify', code, userId, fullName, expiresAt: Date.now() + VERIFY_CODE_TTL });
}

/**
 * portal: "admin"/"staff"/"therapist" for the dedicated role-scoped login pages,
 * otherwise the public login. Each dedicated portal only accepts its matching
 * role(s) (therapist covers both "ot" and "speech"), and the public login
 * rejects admin accounts (they must use /admin/login). Mismatches all get the
 * same generic error so no page leaks which roles exist.
 */
function portalMatchesRole(portal, role) {
  if (portal === 'admin') return role === 'admin';
  if (portal === 'staff') return role === 'staff';
  if (portal === 'therapist') return role === 'ot' || role === 'speech';
  return role !== 'admin';
}

/**
 * POST /api/auth/login  { email, password, portal? }
 */
router.post('/login', loginRateLimit, async (req, res) => {
  const { email, password, portal } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) {
      return res.status(401).json({
        error: 'Please verify your email before signing in. Check your inbox for the verification code.',
        needsVerification: true
      });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const meta = data.user.user_metadata || {};
  const role = data.user.app_metadata?.role || 'parent';
  if (!portalMatchesRole(portal, role)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // The auth user must still have a live profile row, a deleted or
  // deactivated profile means the account no longer exists for the app.
  // select('*') so a not-yet-migrated column can never error out and
  // masquerade as a missing profile ("account disabled").
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).single();
  if (!profile || profile.active === false) {
    return res.status(401).json({ error: 'This account has been disabled or removed. Please contact the clinic.' });
  }

  // Fire-and-forget: a login is a self-action (record_id === created_by), lets
  // the Security Audit Logs' per-user activity view show how many times this
  // account has signed in. Never throws, doesn't block the response.
  logAudit({ table_name: 'profiles', record_id: data.user.id, action: 'login', description: `Signed in (${role})`, created_by: data.user.id });

  res.json({
    token: data.session.access_token,
    user: {
      id: data.user.id,
      email: data.user.email,
      role,
      specialty: profile.specialty || null,
      name: meta.full_name || data.user.email,
      contact: profile.contact || null,
      privacy_consent_at: profile.privacy_consent_at || null,
      must_change_password: profile.must_change_password === true
    }
  });
});

/**
 * POST /api/auth/consent, records acceptance of the Data Privacy Notice
 * (RA 10173). Idempotent: the first acceptance timestamp is kept.
 */
router.post('/consent', requireAuth, async (req, res) => {
  const { data: profile } = await db.from('profiles').select('*').eq('id', req.user.id).single();
  if (profile?.privacy_consent_at) {
    return res.json({ ok: true, consented_at: profile.privacy_consent_at });
  }
  const now = new Date().toISOString();
  const { error } = await db.from('profiles').update({ privacy_consent_at: now }).eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, consented_at: now });
});

/**
 * POST /api/auth/signup  { first_name, last_name, email, password, contact }
 * Self-service registration for parents/guardians only, creates the
 * Supabase Auth user (role: parent, unverified) plus its profiles row.
 * full_name is derived from first + last and kept only as a display value.
 */
router.post('/signup', signupLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  // Accept first/last (new) or a legacy full_name and split it.
  let first_name = (req.body?.first_name || '').trim();
  let last_name = (req.body?.last_name || '').trim();
  if (!first_name && req.body?.full_name) {
    const parts = String(req.body.full_name).trim().split(/\s+/);
    first_name = parts[0] || '';
    last_name = parts.slice(1).join(' ');
  }
  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ error: 'First name, last name, email, and password are required' });
  }
  const full_name = `${first_name} ${last_name}`;
  const pwErr = passwordPolicyError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // Contact number: required, and must be a valid PH mobile number not
  // already registered to another account.
  if (!req.body?.contact) {
    return res.status(400).json({ error: 'Contact number is required.' });
  }
  const contact = normalizePhone(req.body.contact);
  if (!contact) {
    return res.status(400).json({ error: 'Contact number must start with +63 followed by the mobile number (e.g. +639171234567).' });
  }
  const { data: taken } = await db.from('profiles').select('id').eq('contact', contact).maybeSingle();
  if (taken) {
    return res.status(400).json({ error: 'This contact number is already registered to another account.' });
  }

  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email: email.trim(),
    password,
    email_confirm: false, // account stays locked until the emailed verification link is clicked
    user_metadata: { full_name, first_name, last_name, contact },
    app_metadata: { role: 'parent' } // authoritative for authorization, see middleware/auth.js
  });
  if (createErr) {
    if (!/already been registered|already exists/i.test(createErr.message)) {
      console.error('Signup createUser error:', createErr.message);
      return res.status(400).json({ error: createErr.message });
    }

    // Duplicate email. If the existing account never verified, treat this as a
    // retry of an interrupted signup: repair a missing profile row, take the
    // retried password, and send a fresh verification link instead of dead-ending.
    let existing = null;
    const { data: profile } = await db.from('profiles').select('id').ilike('email', email.trim()).maybeSingle();
    if (profile) {
      const { data: got } = await db.auth.admin.getUserById(profile.id);
      existing = got?.user || null;
    } else {
      const { data: page } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      existing = page?.users?.find(u => (u.email || '').toLowerCase() === email.trim().toLowerCase()) || null;
    }

    if (existing && !existing.email_confirmed_at) {
      if (!profile) {
        await db.from('profiles').insert({
          id: existing.id,
          user_code: await nextUserCode(),
          email: existing.email,
          first_name,
          last_name,
          full_name,
          contact,
          role: 'parent',
          active: true
        });
      }
      await db.auth.admin.updateUserById(existing.id, {
        password,
        user_metadata: { full_name, first_name, last_name, contact },
        app_metadata: { role: 'parent' }
      });
      let emailSent = true;
      try {
        await sendVerificationEmail({
          userId: existing.id,
          email: existing.email,
          fullName: first_name
        });
      } catch (e) {
        console.error('Verification email error:', e.message);
        emailSent = false;
      }
      return res.status(201).json({ created: true, verifyEmail: true, emailSent, email: existing.email });
    }

    return res.status(400).json({ error: 'An account with that email already exists' });
  }

  // From here on, the auth user exists. Anything that fails before we've
  // successfully written the profile row (including an unexpected throw, not
  // just a returned error) rolls the auth user back, so a failed signup never
  // leaves a half-created account sitting in the database with no feedback.
  try {
    const { error: profileErr } = await db.from('profiles').insert({
      id: created.user.id,
      user_code: await nextUserCode(),
      email: created.user.email,
      first_name,
      last_name,
      full_name,
      contact,
      role: 'parent',
      active: true
    });
    if (profileErr) throw new Error(profileErr.message);
  } catch (e) {
    console.error('Signup profile insert error:', e.message);
    await db.auth.admin.deleteUser(created.user.id).catch(rollbackErr => console.error('Signup rollback failed:', rollbackErr.message));
    return res.status(500).json({ error: 'Could not finish creating your account, nothing was saved. Please try again.' });
  }

  // The profile row is committed at this point, so the account is real even
  // if the email below fails, that failure is reported via emailSent instead
  // of rolling anything back.
  let emailSent = true;
  try {
    await sendVerificationEmail({
      userId: created.user.id,
      email: created.user.email,
      fullName: first_name
    });
  } catch (e) {
    console.error('Verification email error:', e.message);
    emailSent = false;
  }

  res.status(201).json({ created: true, verifyEmail: true, emailSent, email: created.user.email });
});

/** POST /api/auth/verify-email  { email, code }, activates the account once the emailed code matches */
router.post('/verify-email', codeLimiter, async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  const key = email.trim().toLowerCase();

  const entry = await getCode(key, 'email_verify');
  if (!entry || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode(key, 'email_verify');
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  const { error } = await db.auth.admin.updateUserById(entry.user_id, { email_confirm: true });
  if (error) return res.status(500).json({ error: 'Could not verify your email: ' + error.message });

  await deleteCode(key, 'email_verify');
  res.json({ ok: true, message: 'Email verified. You can now sign in.' });

  // Welcome email, fire-and-forget, the account is verified either way.
  const origin = req.headers.origin || 'http://localhost:5173';
  sendMail({
    to: email.trim(),
    subject: 'Welcome to KID Clinic!',
    html: `
      <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
          <p style="color: #64748B; font-size: 13px;">Pediatric Speech & Occupational Therapy</p>
        </div>
        <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px;">
          <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${entry.full_name || 'there'},</p>
          <p style="color: #64748B; font-size: 13px; margin: 0 0 16px; line-height: 1.7;">
            Your account is verified and ready, welcome to the KID Clinic family! From your parent portal you can:
          </p>
          <ul style="color: #64748B; font-size: 13px; margin: 0 0 20px; padding-left: 20px; line-height: 2;">
            <li>Register your child's profile</li>
            <li>Book therapy sessions</li>
            <li>Follow your child's milestones and progress</li>
            <li>Manage payments</li>
          </ul>
          <div style="text-align: center;">
            <a href="${origin}/login" style="background: #1F4E9E; color: #fff; font-size: 14px; font-weight: 700; padding: 12px 28px; border-radius: 8px; display: inline-block; text-decoration: none;">Sign In to Your Portal</a>
          </div>
          <p style="color: #94A3B8; font-size: 12px; margin: 20px 0 0; text-align: center;">Bloomsdale Therapy Center · Imus, Cavite</p>
        </div>
      </div>
    `
  }).catch(e => console.error('Welcome email error:', e.message));
});

/** POST /api/auth/resend-verification  { email } */
router.post('/resend-verification', emailLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const key = email.trim().toLowerCase();

  const existing = await getCode(key, 'email_verify');
  if (existing) {
    const elapsed = Date.now() - new Date(existing.created_at).getTime();
    if (elapsed < RESEND_COOLDOWN) {
      const wait = Math.ceil((RESEND_COOLDOWN - elapsed) / 1000);
      return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
    }
  }

  const { data: profile } = await db.from('profiles').select('id, full_name').ilike('email', email.trim()).single();
  // Don't reveal whether the email is registered, respond the same either way.
  if (!profile) return res.json({ ok: true, message: 'If that email has an unverified account, a new code has been sent.' });

  const { data: authUser } = await db.auth.admin.getUserById(profile.id);
  if (authUser?.user?.email_confirmed_at) {
    return res.json({ ok: true, alreadyVerified: true, message: 'This account is already verified. You can sign in.' });
  }

  try {
    await sendVerificationEmail({
      userId: profile.id,
      email: email.trim(),
      fullName: profile.full_name
    });
    res.json({ ok: true, message: 'If that email has an unverified account, a new code has been sent.' });
  } catch (e) {
    console.error('Resend verification error:', e.message);
    res.status(500).json({ error: 'Failed to send email. Please try again later.' });
  }
});

/**
 * GET /api/auth/me, session check used on app load. Confirms both the
 * token (via requireAuth) and that the account still has a live profile,
 * so deleted/deactivated accounts get kicked out of the client.
 */
router.get('/me', requireAuth, async (req, res) => {
  const { data: profile } = await db.from('profiles').select('*').eq('id', req.user.id).single();
  if (!profile || profile.active === false) {
    return res.status(401).json({ error: 'This account has been disabled or removed.' });
  }
  res.json({
    user: {
      ...req.user,
      specialty: profile.specialty || null,
      contact: profile.contact || null,
      privacy_consent_at: profile.privacy_consent_at || null,
      must_change_password: profile.must_change_password === true
    }
  });
});

/**
 * PUT /api/auth/me { contact }, self-service update of your own contact
 * number (e.g. the guardian/caretaker "My Profile" panel). Any authenticated
 * role can use this for their own account; it never touches other users.
 */
router.put('/me', requireAuth, async (req, res) => {
  const contact = normalizePhone(req.body?.contact);
  if (!contact) return res.status(400).json({ error: 'Contact number must be a PH mobile number (e.g. 09171234567 or +639171234567).' });

  const { data: taken } = await db.from('profiles').select('id').eq('contact', contact).neq('id', req.user.id).maybeSingle();
  if (taken) return res.status(400).json({ error: 'This contact number is already registered to another account.' });

  const { data, error } = await db.from('profiles').update({ contact }).eq('id', req.user.id).select('contact').single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'profiles', record_id: req.user.id, action: 'update',
    description: 'Updated own contact number', updated_by: req.user.id
  });

  res.json({ contact: data.contact });
});

/**
 * POST /api/auth/change-password  { currentPassword, newPassword }
 * Used for the forced first-login password change (must_change_password),
 * and works generally for any authenticated user who wants to change
 * their own password. Requires the current password to confirm identity,  * the admin-set temporary password on first use, or the existing one after.
 */
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  const pwErr = passwordPolicyError(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // Re-verify identity with the current password before allowing the change.
  const { error: verifyErr } = await authClient.auth.signInWithPassword({ email: req.user.email, password: currentPassword });
  if (verifyErr) return res.status(401).json({ error: 'Current password is incorrect' });

  const { error } = await db.auth.admin.updateUserById(req.user.id, { password: newPassword });
  if (error) return res.status(500).json({ error: 'Failed to update password: ' + error.message });

  const { error: profileErr } = await db.from('profiles').update({ must_change_password: false }).eq('id', req.user.id);
  if (profileErr) return res.status(500).json({ error: 'Password updated, but failed to clear the change flag: ' + profileErr.message });

  res.json({ ok: true, message: 'Password updated successfully.' });
});

/** POST /api/auth/forgot-password  { email } */
router.post('/forgot-password', emailLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const NEUTRAL_MSG = 'If that email is registered, a reset code has been sent.';

  // Don't reveal whether the email is registered, respond identically either way,
  // so this endpoint can't be used to probe which emails have accounts.
  const { data: profile } = await db.from('profiles').select('id, full_name').ilike('email', email.trim()).single();
  if (!profile) {
    return res.json({ ok: true, message: NEUTRAL_MSG });
  }

  // Generate a 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  // Send via Gmail SMTP (shared transporter, explicit TLS, see mailer.js)
  try {
    await sendMail({
      to: email.trim(),
      subject: 'Password Reset Code: KID Clinic',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
            <p style="color: #64748B; font-size: 13px;">Pediatric Speech & Occupational Therapy</p>
          </div>
          <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px; text-align: center;">
            <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${profile.full_name || 'there'},</p>
            <p style="color: #64748B; font-size: 13px; margin: 0 0 20px;">Use this code to reset your password. It expires in 10 minutes.</p>
            <div style="background: #1F4E9E; color: #fff; font-size: 32px; font-weight: 700; letter-spacing: 8px; padding: 16px 24px; border-radius: 8px; display: inline-block;">${code}</div>
            <p style="color: #94A3B8; font-size: 12px; margin: 20px 0 0;">If you didn't request this, please ignore this email.</p>
          </div>
        </div>
      `
    });

    await setCode({ email: email.trim(), purpose: 'password_reset', code, userId: profile.id, expiresAt });
    res.json({ ok: true, message: NEUTRAL_MSG });
  } catch (e) {
    console.error('SMTP Error:', e.message, e.code || '', e.response || '');
    res.status(500).json({ error: 'Failed to send email. Please try again later.' });
  }
});

/** POST /api/auth/verify-reset-code  { email, code } */
router.post('/verify-reset-code', codeLimiter, async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
  const key = email.trim().toLowerCase();

  // One uniform error for missing/expired/wrong so responses don't reveal
  // whether the email has an account or a pending code.
  const entry = await getCode(key, 'password_reset');
  if (!entry || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode(key, 'password_reset');
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  res.json({ ok: true, message: 'Code verified. You can now set a new password.' });
});

/** POST /api/auth/reset-password  { email, code, newPassword } */
router.post('/reset-password', codeLimiter, async (req, res) => {
  const { email, code, newPassword } = req.body || {};
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Email, code, and new password are required' });
  const pwErr = passwordPolicyError(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const key = email.trim().toLowerCase();

  const entry = await getCode(key, 'password_reset');
  if (!entry || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode(key, 'password_reset');
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  // Update password via Supabase Admin API
  const { error } = await db.auth.admin.updateUserById(entry.user_id, { password: newPassword });
  if (error) return res.status(500).json({ error: 'Failed to update password: ' + error.message });

  // Clean up the code
  await deleteCode(key, 'password_reset');

  res.json({ ok: true, message: 'Password reset successfully. You can now sign in.' });
});

/** POST /api/auth/google, returns the OAuth URL to redirect to */
router.post('/google', async (req, res) => {
  const origin = req.headers.origin || 'http://localhost:5173';
  const { data, error } = await authClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${origin}/login` }
  });
  if (error) return res.status(500).json({ error: 'Google sign-in is not configured. Please contact the administrator.' });
  res.json({ url: data.url });
});

export default router;

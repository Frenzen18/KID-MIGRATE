import { Router } from 'express';
import { authClient, db } from '../supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizePhone, syntheticEmailForPhone } from '../phone.js';
import { sendMail } from '../mailer.js';
import { sendSms } from '../sms.js';
import { nextUserCode } from '../usercode.js';
import { passwordPolicyError, isValidName, EMAIL_RE } from '../validate.js';
import { logAudit } from '../lib/audit.js';
import { setCode, getCode, deleteCode } from '../codes.js';
import { makeLimiter, isProd, MIN } from '../lib/rateLimit.js';

const router = Router();

/* ── Rate limiting (per IP), slows brute force on passwords and reset codes ── */
const loginLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 10, 'Too many login attempts. Please wait a while and try again.');
const adminLoginLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 5, 'Too many login attempts. Please wait a while and try again.');
const signupLimiter = makeLimiter(isProd ? 60 * MIN : 10 * 1000, 5, 'Too many signup attempts. Please wait a while and try again.');
const emailLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 5, 'Too many email requests. Please wait a while and try again.');
const codeLimiter = makeLimiter(isProd ? 15 * MIN : 10 * 1000, 10, 'Too many attempts. Please wait a while and try again.');

/** Admin sign-ins get a stricter budget than the public portal. */
function loginRateLimit(req, res, next) {
  return (req.body?.portal === 'admin' ? adminLoginLimiter : loginLimiter)(req, res, next);
}

/** A login/verify/reset "identifier" typed by the user is either a real
 *  email or a PH mobile number, never ambiguous between the two - resolves
 *  which one it is and returns the normalized form, so every route below
 *  shares one interpretation instead of each guessing separately. */
function resolveIdentifier(raw) {
  const phone = normalizePhone(raw);
  if (phone) return { phone };
  return { email: String(raw || '').trim() };
}

/** { phone } or { email }, whichever `resolveIdentifier` produced, shaped for
 *  passing straight into codes.js's setCode/getCode/deleteCode. */
function codeKeyFor(resolved) {
  return resolved.phone ? { phone: resolved.phone } : { email: resolved.email };
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

/** Same as sendVerificationEmail, texted instead, for a phone-only signup
 *  (see profiles.phone_only) that has no real email to send one to. */
async function sendVerificationSms({ userId, phone, fullName }) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await sendSms({ to: phone, message: `Hi ${fullName || 'there'}! Your KID Clinic verification code is ${code}. It expires in 15 minutes.` });
  await setCode({ phone, purpose: 'email_verify', code, userId, fullName, expiresAt: Date.now() + VERIFY_CODE_TTL });
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
 * POST /api/auth/login  { identifier, password, portal? }
 * `identifier` is either the account's email or its registered mobile
 * number (see resolveIdentifier) - a phone-only account (no real email,
 * profiles.phone_only) can ONLY ever sign in this way, since there's no
 * real email for it to type instead.
 */
router.post('/login', loginRateLimit, async (req, res) => {
  const { identifier, password, portal } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'Email/mobile number and password are required' });

  const resolved = resolveIdentifier(identifier);
  let loginEmail = resolved.email;
  if (resolved.phone) {
    // Phone doesn't map to auth.users directly, look up which (real or
    // synthetic) email this contact number's account actually signs in with.
    const { data: profile } = await db.from('profiles').select('email').eq('contact', resolved.phone).maybeSingle();
    if (!profile) return res.status(401).json({ error: 'Invalid email/mobile number or password' });
    loginEmail = profile.email;
  }

  const { data, error } = await authClient.auth.signInWithPassword({ email: loginEmail, password });
  if (error) {
    if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) {
      return res.status(401).json({
        error: 'Please verify your account before signing in. Check for the verification code.',
        needsVerification: true
      });
    }
    return res.status(401).json({ error: 'Invalid email/mobile number or password' });
  }

  const meta = data.user.user_metadata || {};
  const role = data.user.app_metadata?.role || 'parent';
  if (!portalMatchesRole(portal, role)) {
    return res.status(401).json({ error: 'Invalid email/mobile number or password' });
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
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at, // unix seconds, lets the client refresh ahead of the 1-hour expiry instead of only reacting after it
    user: {
      id: data.user.id,
      // A phone-only account's "email" is just an internal placeholder
      // (see profiles.phone_only), never shown to or usable by the user,
      // so the client never sees it either.
      email: profile.phone_only ? null : data.user.email,
      role,
      specialty: profile.specialty || null,
      // profiles.full_name is the authoritative, always-current name (the
      // Edit User form writes here first), user_metadata is only a mirror of
      // it kept for other Supabase-side uses and can drift stale if it was
      // ever set before that sync existed, prefer the fresh column.
      name: profile.full_name || meta.full_name || (profile.phone_only ? profile.contact : data.user.email),
      contact: profile.contact || null,
      privacy_consent_at: profile.privacy_consent_at || null,
      must_change_password: profile.must_change_password === true
    }
  });
});

/**
 * POST /api/auth/refresh  { refresh_token }
 * Exchanges a still-valid refresh token for a new access token, silently,
 * so a session doesn't just die the instant the 1-hour access token expires,
 * every portal (admin/staff/therapist/parent) was hard-logging-out mid-use
 * with no warning before this existed. No requireAuth here on purpose, the
 * access token is presumed already expired, that's the whole point of calling this.
 */
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });

  const { data, error } = await authClient.auth.refreshSession({ refresh_token });
  if (error || !data?.session) {
    return res.status(401).json({ error: 'Session expired, please sign in again.' });
  }

  res.json({
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at
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
  const { password } = req.body || {};
  const email = (req.body?.email || '').trim();
  // Accept first/last (new) or a legacy full_name and split it.
  let first_name = (req.body?.first_name || '').trim();
  let last_name = (req.body?.last_name || '').trim();
  if (!first_name && req.body?.full_name) {
    const parts = String(req.body.full_name).trim().split(/\s+/);
    first_name = parts[0] || '';
    last_name = parts.slice(1).join(' ');
  }
  if (!first_name || !last_name || !password) {
    return res.status(400).json({ error: 'First name, last name, and password are required' });
  }
  if (!isValidName(first_name) || !isValidName(last_name)) {
    return res.status(400).json({ error: 'Names can only contain letters, spaces, hyphens, and apostrophes.' });
  }
  const full_name = `${first_name} ${last_name}`;
  const pwErr = passwordPolicyError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address, or leave it blank if you don\'t have one.' });
  }

  // Contact number: required, and must be a valid PH mobile number not
  // already registered to another account. It's also the login credential
  // for anyone signing up without an email at all (see phoneOnly below).
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

  // No email given: Supabase Auth still needs one to key the account on
  // (see server/phone.js), the guardian only ever signs in / verifies /
  // resets by phone from here on, they never see or type this placeholder.
  const phoneOnly = !email;
  const authEmail = phoneOnly ? syntheticEmailForPhone(contact) : email;

  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email: authEmail,
    password,
    email_confirm: false, // account stays locked until the verification code is entered
    user_metadata: { full_name, first_name, last_name, contact },
    app_metadata: { role: 'parent' } // authoritative for authorization, see middleware/auth.js
  });
  if (createErr) {
    if (!/already been registered|already exists/i.test(createErr.message)) {
      console.error('Signup createUser error:', createErr.message);
      return res.status(400).json({ error: createErr.message });
    }
    if (phoneOnly) {
      // The synthetic email is deterministic per phone number, and contact
      // uniqueness was already checked above, so this can only mean the
      // earlier check raced with another signup for the same number.
      return res.status(400).json({ error: 'This contact number is already registered to another account.' });
    }

    // Duplicate email. If the existing account never verified, treat this as a
    // retry of an interrupted signup: repair a missing profile row, take the
    // retried password, and send a fresh verification code instead of dead-ending.
    let existing = null;
    const { data: profile } = await db.from('profiles').select('id').ilike('email', authEmail).maybeSingle();
    if (profile) {
      const { data: got } = await db.auth.admin.getUserById(profile.id);
      existing = got?.user || null;
    } else {
      const { data: page } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      existing = page?.users?.find(u => (u.email || '').toLowerCase() === authEmail.toLowerCase()) || null;
    }

    if (existing && !existing.email_confirmed_at) {
      if (!profile) {
        await db.from('profiles').insert({
          id: existing.id,
          user_code: await nextUserCode(),
          email: existing.email,
          phone_only: false,
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
      return res.status(201).json({ created: true, verifyEmail: true, emailSent, phoneOnly: false, identifier: existing.email });
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
      email: authEmail,
      phone_only: phoneOnly,
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
  // if the code below fails to send, that failure is reported via emailSent
  // instead of rolling anything back.
  let emailSent = true;
  try {
    if (phoneOnly) await sendVerificationSms({ userId: created.user.id, phone: contact, fullName: first_name });
    else await sendVerificationEmail({ userId: created.user.id, email: authEmail, fullName: first_name });
  } catch (e) {
    console.error('Verification code send error:', e.message);
    emailSent = false;
  }

  res.status(201).json({ created: true, verifyEmail: true, emailSent, phoneOnly, identifier: phoneOnly ? contact : authEmail });
});

/** POST /api/auth/verify-email  { identifier, code }, activates the account once the code matches */
router.post('/verify-email', codeLimiter, async (req, res) => {
  const { identifier, code } = req.body || {};
  if (!identifier || !code) return res.status(400).json({ error: 'Email/mobile number and code are required' });
  const resolved = resolveIdentifier(identifier);
  const key = codeKeyFor(resolved);

  const entry = await getCode({ ...key, purpose: 'email_verify' });
  if (!entry || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode({ ...key, purpose: 'email_verify' });
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  const { error } = await db.auth.admin.updateUserById(entry.user_id, { email_confirm: true });
  if (error) return res.status(500).json({ error: 'Could not verify your account: ' + error.message });

  await deleteCode({ ...key, purpose: 'email_verify' });
  res.json({ ok: true, message: 'Verified. You can now sign in.' });

  // Welcome message, fire-and-forget, the account is verified either way.
  if (resolved.phone) {
    sendSms({ to: resolved.phone, message: `Welcome to KID Clinic, ${entry.full_name || 'there'}! Your account is verified, you can now sign in.` })
      .catch(e => console.error('Welcome SMS error:', e.message));
    return;
  }
  const origin = req.headers.origin || 'http://localhost:5173';
  sendMail({
    to: resolved.email,
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

/** POST /api/auth/resend-verification  { identifier } */
router.post('/resend-verification', emailLimiter, async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ error: 'Email or mobile number is required' });
  const resolved = resolveIdentifier(identifier);
  const key = codeKeyFor(resolved);
  const NEUTRAL_MSG = 'If that account exists and needs verification, a new code has been sent.';

  const existing = await getCode({ ...key, purpose: 'email_verify' });
  if (existing) {
    const elapsed = Date.now() - new Date(existing.created_at).getTime();
    if (elapsed < RESEND_COOLDOWN) {
      const wait = Math.ceil((RESEND_COOLDOWN - elapsed) / 1000);
      return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
    }
  }

  const profileQuery = resolved.phone
    ? db.from('profiles').select('id, full_name').eq('contact', resolved.phone)
    : db.from('profiles').select('id, full_name').ilike('email', resolved.email);
  const { data: profile } = await profileQuery.maybeSingle();
  // Don't reveal whether the account exists, respond the same either way.
  if (!profile) return res.json({ ok: true, message: NEUTRAL_MSG });

  const { data: authUser } = await db.auth.admin.getUserById(profile.id);
  if (authUser?.user?.email_confirmed_at) {
    return res.json({ ok: true, alreadyVerified: true, message: 'This account is already verified. You can sign in.' });
  }

  try {
    if (resolved.phone) await sendVerificationSms({ userId: profile.id, phone: resolved.phone, fullName: profile.full_name });
    else await sendVerificationEmail({ userId: profile.id, email: resolved.email, fullName: profile.full_name });
    res.json({ ok: true, message: NEUTRAL_MSG });
  } catch (e) {
    console.error('Resend verification error:', e.message);
    res.status(500).json({ error: 'Failed to send the code. Please try again later.' });
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
      // Same reasoning as /login: profiles.full_name is authoritative,
      // req.user.name (from middleware/auth.js) reflects Supabase Auth's
      // user_metadata, which can lag behind if it was set before that sync
      // existed. This is the path an app refresh/session-restore actually
      // hits far more often than a fresh login, so it matters more here.
      name: profile.full_name || req.user.name,
      // A phone-only account's "email" is just an internal placeholder
      // (see profiles.phone_only), never shown to or usable by the user.
      email: profile.phone_only ? null : req.user.email,
      specialty: profile.specialty || null,
      contact: profile.contact || null,
      privacy_consent_at: profile.privacy_consent_at || null,
      must_change_password: profile.must_change_password === true
    }
  });
});

/**
 * GET /api/auth/session-check, the timestamp of the most recent successful
 * login on this account (see the `login` audit event recorded in POST
 * /login), so the client can tell "a newer sign-in happened than the one I'm
 * using" and warn the user their account may be signed in somewhere else.
 */
router.get('/session-check', requireAuth, async (req, res) => {
  const { data } = await db.from('audit_logs')
    .select('created_at')
    .eq('table_name', 'profiles')
    .eq('record_id', req.user.id)
    .eq('action', 'login')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  res.json({ last_login_at: data?.created_at || null });
});

/**
 * Self-service email/phone changes from the guardian/caretaker "My Profile"
 * panel now require proving ownership of the NEW address/number before it's
 * written anywhere, the same code-in-verification_codes machinery signup and
 * password reset already use (see server/codes.js), just under two purposes
 * of its own so a stray code from one flow can never confirm another. Each
 * field is request-code (send, or resend if already pending) then
 * confirm-code (checks it, then applies the change) - nothing is written to
 * profiles/auth.users until confirm succeeds.
 */
function requestCodeCooldownError(entry) {
  if (!entry) return null;
  const elapsed = Date.now() - new Date(entry.created_at).getTime();
  if (elapsed >= RESEND_COOLDOWN) return null;
  return `Please wait ${Math.ceil((RESEND_COOLDOWN - elapsed) / 1000)}s before requesting another code.`;
}

/** POST /api/auth/me/request-email-code  { email } */
router.post('/me/request-email-code', requireAuth, emailLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const { data: taken } = await db.from('profiles').select('id').ilike('email', email).neq('id', req.user.id).maybeSingle();
  if (taken) return res.status(400).json({ error: 'This email address is already registered to another account.' });

  const cooldownErr = requestCodeCooldownError(await getCode({ email, purpose: 'profile_email' }));
  if (cooldownErr) return res.status(429).json({ error: cooldownErr });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await sendMail({
      to: email,
      subject: 'Confirm your email: KID Clinic',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
            <p style="color: #64748B; font-size: 13px;">Pediatric Speech &amp; Occupational Therapy</p>
          </div>
          <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px; text-align: center;">
            <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${req.user.name || 'there'},</p>
            <p style="color: #64748B; font-size: 13px; margin: 0 0 20px;">Use this code to confirm this email address for your KID Clinic account. It expires in 15 minutes.</p>
            <div style="background: #1F4E9E; color: #fff; font-size: 32px; font-weight: 700; letter-spacing: 8px; padding: 16px 24px; border-radius: 8px; display: inline-block;">${code}</div>
            <p style="color: #94A3B8; font-size: 12px; margin: 20px 0 0;">If you didn't request this, please ignore this email.</p>
          </div>
        </div>
      `
    });
    await setCode({ email, purpose: 'profile_email', code, userId: req.user.id, fullName: req.user.name, expiresAt: Date.now() + VERIFY_CODE_TTL });
    res.json({ ok: true, message: 'A verification code has been sent to that email address.' });
  } catch (e) {
    console.error('Profile email code send error:', e.message);
    res.status(500).json({ error: 'Failed to send the code. Please try again later.' });
  }
});

/** POST /api/auth/me/confirm-email-code  { email, code } */
router.post('/me/confirm-email-code', requireAuth, codeLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const { code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

  const entry = await getCode({ email, purpose: 'profile_email' });
  if (!entry || entry.user_id !== req.user.id || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode({ email, purpose: 'profile_email' });
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  const { error: authErr } = await db.auth.admin.updateUserById(req.user.id, { email, email_confirm: true });
  if (authErr) return res.status(500).json({ error: 'Could not update your email: ' + authErr.message });

  // A phone-only account (see profiles.phone_only) had only a synthetic
  // placeholder before, confirming a real one graduates it to a normal account.
  const { error } = await db.from('profiles').update({ email, phone_only: false }).eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });

  await deleteCode({ email, purpose: 'profile_email' });
  await logAudit({
    table_name: 'profiles', record_id: req.user.id, action: 'update',
    description: 'Updated own email address', updated_by: req.user.id
  });

  res.json({ email });
});

/** POST /api/auth/me/request-phone-code  { contact } */
router.post('/me/request-phone-code', requireAuth, emailLimiter, async (req, res) => {
  const contact = normalizePhone(req.body?.contact);
  if (!contact) return res.status(400).json({ error: 'Contact number must be a PH mobile number (e.g. 09171234567 or +639171234567).' });

  const { data: taken } = await db.from('profiles').select('id').eq('contact', contact).neq('id', req.user.id).maybeSingle();
  if (taken) return res.status(400).json({ error: 'This contact number is already registered to another account.' });

  const cooldownErr = requestCodeCooldownError(await getCode({ phone: contact, purpose: 'profile_phone' }));
  if (cooldownErr) return res.status(429).json({ error: cooldownErr });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    await sendSms({ to: contact, message: `Hi ${req.user.name || 'there'}! Your KID Clinic phone number update code is ${code}. It expires in 15 minutes.` });
    await setCode({ phone: contact, purpose: 'profile_phone', code, userId: req.user.id, fullName: req.user.name, expiresAt: Date.now() + VERIFY_CODE_TTL });
    res.json({ ok: true, message: 'A verification code has been sent to that mobile number.' });
  } catch (e) {
    console.error('Profile phone code send error:', e.message);
    res.status(500).json({ error: 'Failed to send the code. Please try again later.' });
  }
});

/** POST /api/auth/me/confirm-phone-code  { contact, code } */
router.post('/me/confirm-phone-code', requireAuth, codeLimiter, async (req, res) => {
  const contact = normalizePhone(req.body?.contact);
  const { code } = req.body || {};
  if (!contact || !code) return res.status(400).json({ error: 'Contact number and code are required.' });

  const entry = await getCode({ phone: contact, purpose: 'profile_phone' });
  if (!entry || entry.user_id !== req.user.id || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode({ phone: contact, purpose: 'profile_phone' });
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  const { data, error } = await db.from('profiles').update({ contact }).eq('id', req.user.id).select('contact').single();
  if (error) return res.status(500).json({ error: error.message });

  await deleteCode({ phone: contact, purpose: 'profile_phone' });
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

  // Changing the password via the admin API revokes the session tied to the
  // access token the caller just authenticated with, every request right
  // after this would otherwise 401 until they logged out and back in. Sign
  // in again with the new password so the client can swap to a live token.
  const { data: fresh, error: signInErr } = await authClient.auth.signInWithPassword({ email: req.user.email, password: newPassword });
  if (signInErr || !fresh?.session) return res.status(500).json({ error: 'Password updated, but failed to start a new session. Please sign in again.' });

  res.json({
    ok: true, message: 'Password updated successfully.',
    token: fresh.session.access_token, refreshToken: fresh.session.refresh_token, expiresAt: fresh.session.expires_at
  });
});

/** POST /api/auth/forgot-password  { identifier } */
router.post('/forgot-password', emailLimiter, async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ error: 'Email or mobile number is required' });
  const resolved = resolveIdentifier(identifier);

  const NEUTRAL_MSG = 'If that account is registered, a reset code has been sent.';

  // Don't reveal whether the account is registered, respond identically
  // either way, so this endpoint can't be used to probe which accounts exist.
  const profileQuery = resolved.phone
    ? db.from('profiles').select('id, full_name, email').eq('contact', resolved.phone)
    : db.from('profiles').select('id, full_name, email').ilike('email', resolved.email);
  const { data: profile } = await profileQuery.maybeSingle();
  if (!profile) {
    return res.json({ ok: true, message: NEUTRAL_MSG });
  }

  // Generate a 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  try {
    if (resolved.phone) {
      await sendSms({ to: resolved.phone, message: `Hi ${profile.full_name || 'there'}! Your KID Clinic password reset code is ${code}. It expires in 10 minutes.` });
      await setCode({ phone: resolved.phone, purpose: 'password_reset', code, userId: profile.id, expiresAt });
    } else {
      // Send via Gmail SMTP (shared transporter, explicit TLS, see mailer.js)
      await sendMail({
        to: resolved.email,
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
      await setCode({ email: resolved.email, purpose: 'password_reset', code, userId: profile.id, expiresAt });
    }
    res.json({ ok: true, message: NEUTRAL_MSG });
  } catch (e) {
    console.error('Password reset code send error:', e.message, e.code || '', e.response || '');
    res.status(500).json({ error: 'Failed to send the code. Please try again later.' });
  }
});

/** POST /api/auth/verify-reset-code  { identifier, code } */
router.post('/verify-reset-code', codeLimiter, async (req, res) => {
  const { identifier, code } = req.body || {};
  if (!identifier || !code) return res.status(400).json({ error: 'Email/mobile number and code are required' });
  const key = codeKeyFor(resolveIdentifier(identifier));

  // One uniform error for missing/expired/wrong so responses don't reveal
  // whether the account has an account or a pending code.
  const entry = await getCode({ ...key, purpose: 'password_reset' });
  if (!entry || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode({ ...key, purpose: 'password_reset' });
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  res.json({ ok: true, message: 'Code verified. You can now set a new password.' });
});

/** POST /api/auth/reset-password  { identifier, code, newPassword } */
router.post('/reset-password', codeLimiter, async (req, res) => {
  const { identifier, code, newPassword } = req.body || {};
  if (!identifier || !code || !newPassword) return res.status(400).json({ error: 'Email/mobile number, code, and new password are required' });
  const pwErr = passwordPolicyError(newPassword);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const key = codeKeyFor(resolveIdentifier(identifier));

  const entry = await getCode({ ...key, purpose: 'password_reset' });
  if (!entry || Date.now() > new Date(entry.expires_at).getTime()) {
    if (entry) await deleteCode({ ...key, purpose: 'password_reset' });
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.status(400).json({ error: 'Invalid or expired code. Please check the code or request a new one.' });
  }

  // Update password via Supabase Admin API
  const { error } = await db.auth.admin.updateUserById(entry.user_id, { password: newPassword });
  if (error) return res.status(500).json({ error: 'Failed to update password: ' + error.message });

  // Clean up the code
  await deleteCode({ ...key, purpose: 'password_reset' });

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

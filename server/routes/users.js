import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { normalizePhone } from '../phone.js';
import { nextUserCode } from '../usercode.js';
import { EMAIL_RE, passwordPolicyError } from '../validate.js';
import { logAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

/** GET /api/users, all portal accounts (staff too, so 12.3 Push Trigger can target a specific user) */
router.get('/', requireRole('admin', 'staff'), async (req, res) => {
  const { data, error } = await db.from('profiles').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Backfill: accounts created before the ID system get a KID-YYYY-NNNN
  // code now (oldest first), so every user always has a unique ID.
  const missing = data.filter(p => !p.user_code)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const p of missing) {
    const code = await nextUserCode();
    const { error: uErr } = await db.from('profiles').update({ user_code: code }).eq('id', p.id);
    if (!uErr) p.user_code = code;
  }

  res.json(data);
});

/** POST /api/users, create an account { email, password, first_name, last_name, role, contact? } */
router.post('/', requireRole('admin'), async (req, res) => {
  const { email, password, role } = req.body || {};
  // Accept first/last (new) or a legacy full_name and split it.
  let first_name = (req.body?.first_name || '').trim();
  let last_name = (req.body?.last_name || '').trim();
  if (!first_name && req.body?.full_name) {
    const parts = String(req.body.full_name).trim().split(/\s+/);
    first_name = parts[0] || '';
    last_name = parts.slice(1).join(' ');
  }
  if (!email || !password || !first_name || !role) {
    return res.status(400).json({ error: 'email, password, first name and role are required' });
  }
  if (!['admin', 'staff', 'ot', 'speech', 'parent'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const full_name = last_name ? `${first_name} ${last_name}` : first_name;

  if (!EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const pwErr = passwordPolicyError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  // Duplicate checks, clear errors instead of raw database failures.
  const { data: emailTaken } = await db.from('profiles').select('id').ilike('email', String(email).trim()).maybeSingle();
  if (emailTaken) {
    return res.status(400).json({ error: 'This email is already registered to another account.' });
  }
  const { data: nameTaken } = await db.from('profiles').select('id, full_name').ilike('full_name', full_name).maybeSingle();
  if (nameTaken) {
    return res.status(400).json({ error: `A user named "${nameTaken.full_name}" already exists.` });
  }

  let contact = null;
  if (req.body?.contact) {
    contact = normalizePhone(req.body.contact);
    if (!contact) return res.status(400).json({ error: 'Contact number must be a PH mobile number (e.g. 09171234567 or +639171234567).' });
    const { data: taken } = await db.from('profiles').select('id').eq('contact', contact).maybeSingle();
    if (taken) return res.status(400).json({ error: 'This contact number is already registered to another account.' });
  }

  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, first_name, last_name },
    app_metadata: { role } // authoritative for authorization, see middleware/auth.js
  });
  if (error) {
    // The profiles pre-check can miss an auth-only account, map to the same friendly message.
    const msg = /already been registered|already exists/i.test(error.message)
      ? 'This email is already registered to another account.'
      : error.message;
    return res.status(400).json({ error: msg });
  }

  // Auto-generated unique account ID: KID-YYYY-NNNN
  const user_code = await nextUserCode();

  const { error: pErr } = await db.from('profiles').insert({
    id: data.user.id, user_code, email, first_name, last_name, full_name, contact, role, active: true, must_change_password: true
  });
  if (pErr) return res.status(500).json({ error: pErr.message });

  await logAudit({
    table_name: 'profiles', record_id: data.user.id, action: 'create',
    description: `Created ${role} account for ${full_name} (${email})`,
    created_by: req.user.id
  });

  res.status(201).json({ id: data.user.id, user_code, email, full_name, role, must_change_password: true });
});

/** PUT /api/users/:id, update names / role / active flag */
router.put('/:id', requireRole('admin'), async (req, res) => {
  const patch = {};
  for (const k of ['full_name', 'first_name', 'last_name', 'role', 'active']) if (k in req.body) patch[k] = req.body[k];

  // Guardian/Caretaker is a portal category, not a staff role, block crossing the boundary in
  // either direction (the client's Edit User form already only offers same-category options,
  // this is the server-side backstop for direct API calls).
  if (patch.role) {
    const { data: currentProfile } = await db.from('profiles').select('role').eq('id', req.params.id).maybeSingle();
    const wasParent = currentProfile?.role === 'parent';
    const willBeParent = patch.role === 'parent';
    if (wasParent !== willBeParent) {
      return res.status(400).json({ error: 'Guardian/Caretaker accounts cannot be reassigned to a staff role, and staff accounts cannot be reassigned to Guardian/Caretaker.' });
    }
  }

  if ('contact' in req.body) {
    if (req.body.contact) {
      const contact = normalizePhone(req.body.contact);
      if (!contact) return res.status(400).json({ error: 'Contact number must be a PH mobile number (e.g. 09171234567 or +639171234567).' });
      const { data: taken } = await db.from('profiles').select('id').eq('contact', contact).neq('id', req.params.id).maybeSingle();
      if (taken) return res.status(400).json({ error: 'This contact number is already registered to another account.' });
      patch.contact = contact;
    } else {
      patch.contact = null;
    }
  }

  // Keep the derived full_name in sync when either name part changes.
  if (('first_name' in patch || 'last_name' in patch) && !('full_name' in patch)) {
    const { data: current } = await db.from('profiles').select('first_name, last_name').eq('id', req.params.id).single();
    const first = 'first_name' in patch ? patch.first_name : current?.first_name;
    const last = 'last_name' in patch ? patch.last_name : current?.last_name;
    patch.full_name = [first, last].filter(Boolean).join(' ');
  }

  // Renaming into another user's name is almost always a mistake, block it.
  if (patch.full_name) {
    const { data: nameTaken } = await db.from('profiles')
      .select('id').ilike('full_name', patch.full_name).neq('id', req.params.id).maybeSingle();
    if (nameTaken) return res.status(400).json({ error: `Another user named "${patch.full_name}" already exists.` });
  }

  const { data, error } = await db.from('profiles').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (patch.role || patch.full_name) {
    await db.auth.admin.updateUserById(req.params.id, {
      user_metadata: { full_name: data.full_name, first_name: data.first_name, last_name: data.last_name },
      ...(patch.role ? { app_metadata: { role: data.role } } : {})
    });
  }

  await logAudit({
    table_name: 'profiles', record_id: req.params.id, action: 'update',
    description: `Updated account for ${data.full_name}` + (patch.role ? `, role set to ${patch.role}` : '') + (patch.active === false ? ', deactivated' : ''),
    updated_by: req.user.id
  });

  res.json(data);
});

/** DELETE /api/users/:id */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data: existing } = await db.from('profiles').select('full_name').eq('id', req.params.id).maybeSingle();
  await db.from('profiles').delete().eq('id', req.params.id);
  const { error } = await db.auth.admin.deleteUser(req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'profiles', record_id: req.params.id, action: 'delete',
    description: `Deleted account${existing?.full_name ? ' for ' + existing.full_name : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

export default router;

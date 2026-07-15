import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { nextClientCode } from '../usercode.js';
import { logAudit } from '../lib/audit.js';

/** Client IDs carry the enrollment year: CLI-YYYY-NNNN. */
const NEW_CODE_FORMAT = /^CLI-\d{4}-\d{4}$/;

/** Strips PostgREST filter-DSL special characters (,()."*) so user search text can't inject extra filter clauses. */
function sanitizeSearchTerm(s) {
  return String(s).replace(/[,()."*]/g, '').slice(0, 100);
}

/**
 * Validates a raw { [field_id]: value } object against the *current*
 * Development & Functional Information field definitions (admin-configurable
 * via server/routes/devFunctionalFields.js), unknown field ids are dropped,
 * select values must match that field's own option set, text values are
 * trimmed. This is what lets the form be admin-editable without ever trusting
 * a client-submitted value verbatim.
 */
async function validateDevFunctionalData(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const { data: fields } = await db.from('dev_functional_fields').select('*').eq('active', true);
  for (const f of fields || []) {
    const val = raw[f.id];
    if (val == null || val === '') continue;
    if (f.field_type === 'select') {
      if (Array.isArray(f.options) && f.options.includes(val)) out[f.id] = val;
    } else {
      const trimmed = String(val).trim();
      if (trimmed) out[f.id] = trimmed;
    }
  }
  return out;
}

const router = Router();
router.use(requireAuth);

/** GET /api/clients?search=&status=&therapy=, staff/admin/therapist see all; parents see own children */
router.get('/', async (req, res) => {
  let q = db.from('clients').select('*').order('created_at', { ascending: false });
  if (req.user.role === 'parent') q = q.eq('parent_id', req.user.id);
  if (req.query.status) q = q.eq('status', req.query.status);
  if (req.query.therapy) q = q.eq('therapy_type', req.query.therapy);
  if (req.query.search) {
    const term = sanitizeSearchTerm(req.query.search);
    if (term) q = q.or(`full_name.ilike.%${term}%,client_code.ilike.%${term}%`);
  }
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Backfill: clients with an old-format code (CLI-NNNN, no year) get
  // re-coded as CLI-YYYY-NNNN using the year they were enrolled.
  if (req.user.role !== 'parent') {
    const oldFormat = data.filter(c => !NEW_CODE_FORMAT.test(c.client_code || ''))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (const c of oldFormat) {
      const year = new Date(c.created_at || Date.now()).getFullYear();
      const code = await nextClientCode(year);
      const { error: uErr } = await db.from('clients').update({ client_code: code }).eq('id', c.id);
      if (!uErr) c.client_code = code;
    }
  }

  res.json(data);
});

/** GET /api/clients/:id, profile + session notes + attendance */
router.get('/:id', async (req, res) => {
  const { data: client, error } = await db.from('clients').select('*').eq('id', req.params.id).single();
  if (error || !client) return res.status(404).json({ error: 'Client not found' });
  if (req.user.role === 'parent' && client.parent_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your child record' });
  }
  const [{ data: notes }, { data: attendance }, { data: gasEntries }] = await Promise.all([
    db.from('session_notes').select('*').eq('client_id', client.id).order('session_date'),
    db.from('attendance').select('*').eq('client_id', client.id).order('session_date'),
    db.from('gas_entries').select('*').eq('client_id', client.id).order('session_date')
  ]);

  // Attach each GAS entry's own scores, same shape GET /gas/entries returns,
  // so GasProgressChart works identically here (this is how a parent gets to
  // see GAS trends: through their own child's record, not the broader endpoint).
  let gas_entries = [];
  if (gasEntries?.length) {
    const { data: scores } = await db.from('gas_entry_scores').select('*').in('entry_id', gasEntries.map(e => e.id));
    const scoresByEntry = {};
    for (const s of scores || []) (scoresByEntry[s.entry_id] ||= []).push(s);
    gas_entries = gasEntries.map(e => ({ ...e, scores: scoresByEntry[e.id] || [] }));
  }

  res.json({ ...client, session_notes: notes || [], attendance: attendance || [], gas_entries });
});

/** POST /api/clients/self-register, parent self-registers their child (intake form) */
router.post('/self-register', async (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ error: 'Only parents can self-register a child.' });

  const b = req.body || {};
  // Child's name comes in as first/last (full_name accepted as a legacy fallback).
  let childFirst = (b.first_name || '').trim();
  let childLast = (b.last_name || '').trim();
  if (!childFirst && b.full_name) {
    const parts = String(b.full_name).trim().split(/\s+/);
    childFirst = parts[0] || '';
    childLast = parts.slice(1).join(' ');
  }
  if (!childFirst || !childLast) return res.status(400).json({ error: 'Child\'s first name and last name are required.' });
  const childMiddle = (b.middle_name || '').trim();
  const childFull = childMiddle ? `${childFirst} ${childMiddle} ${childLast}` : `${childFirst} ${childLast}`;
  if (!b.dob) return res.status(400).json({ error: 'Date of birth is required.' });
  if (!b.gender) return res.status(400).json({ error: 'Gender is required.' });

  // Patients must be 3–21 years old.
  const dobMs = new Date(b.dob).getTime();
  if (isNaN(dobMs) || dobMs > Date.now()) return res.status(400).json({ error: 'Date of birth is invalid.' });
  const childAge = Math.floor((Date.now() - dobMs) / (365.25 * 24 * 60 * 60 * 1000));
  if (childAge < 3 || childAge > 21) {
    return res.status(400).json({ error: 'Patients must be between 3 and 21 years old.' });
  }

  // Guardian must be an adult, validated from date of birth, same as the child.
  if (!b.guardian_dob) return res.status(400).json({ error: 'Guardian/caretaker date of birth is required.' });
  const guardianDobMs = new Date(b.guardian_dob).getTime();
  if (isNaN(guardianDobMs) || guardianDobMs > Date.now()) {
    return res.status(400).json({ error: 'Guardian/caretaker date of birth is invalid.' });
  }
  const guardianAge = Math.floor((Date.now() - guardianDobMs) / (365.25 * 24 * 60 * 60 * 1000));
  if (guardianAge < 18 || guardianAge > 120) {
    return res.status(400).json({ error: 'Parent/guardian age must be 18 or older.' });
  }

  // Philippine mobile format: +639XXXXXXXXX only.
  const PH_PHONE = /^\+639\d{9}$/;
  if (b.guardian_phone && !PH_PHONE.test(b.guardian_phone)) {
    return res.status(400).json({ error: 'Cell phone must start with +63 followed by the mobile number (e.g. +639171234567).' });
  }
  if (b.other_guardian_phone && !PH_PHONE.test(b.other_guardian_phone)) {
    return res.status(400).json({ error: 'Alternate contact number must start with 09 or +63.' });
  }

  const relationship = ['Parent', 'Guardian', 'Caretaker'].includes(b.guardian_relationship)
    ? b.guardian_relationship : 'Parent';

  // Development & Functional Information, every field is optional (parents may
  // not know the answer yet at intake), validated dynamically against the
  // admin-configurable field list rather than a fixed set of columns.
  const dev_functional_data = await validateDevFunctionalData(b.dev_functional_data);

  // Auto-generated unique client ID: CLI-YYYY-NNNN
  const client_code = await nextClientCode();

  // Diagnosis, medical conditions, and therapy type are deliberately NOT
  // accepted here, the clinic assesses and assigns them (RA 10173 data
  // minimization: parents aren't asked to self-diagnose their child).
  const { data, error } = await db.from('clients').insert({
    client_code,
    first_name: childFirst,
    middle_name: childMiddle || null,
    last_name: childLast,
    full_name: childFull,
    dob: b.dob,
    gender: b.gender,
    guardian_name: b.guardian_name || null,
    guardian_contact: b.guardian_contact || b.guardian_phone || null,
    parent_id: req.user.id,
    therapy_type: null, // set by the clinic after assessment
    status: 'active',
    allergies: b.allergies || null,
    daily_medication: b.daily_medication || null,
    guardian_relationship: relationship,
    guardian_dob: b.guardian_dob,
    guardian_phone: b.guardian_phone || null,
    other_guardian_name: b.other_guardian_name || null,
    other_guardian_phone: b.other_guardian_phone || null,
    dev_functional_data
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clients', record_id: data.id, action: 'create',
    description: `Parent self-registered child ${childFull} (${client_code})`,
    created_by: req.user.id
  });

  res.status(201).json(data);
});

/** POST /api/clients, admin/staff { first_name, last_name | full_name, ... } */
router.post('/', requireRole('admin', 'staff'), async (req, res) => {
  const b = req.body || {};
  let first = (b.first_name || '').trim();
  let last_ = (b.last_name || '').trim();
  if (!first && b.full_name) {
    const parts = String(b.full_name).trim().split(/\s+/);
    first = parts[0] || '';
    last_ = parts.slice(1).join(' ');
  }
  if (!first) return res.status(400).json({ error: 'Child\'s name is required' });
  const fullName = last_ ? `${first} ${last_}` : first;
  // Auto-generated unique client ID: CLI-YYYY-NNNN
  const client_code = await nextClientCode();

  const { data, error } = await db.from('clients').insert({
    client_code,
    first_name: first,
    last_name: last_ || null,
    full_name: fullName,
    dob: b.dob || null,
    gender: b.gender || null,
    guardian_name: b.guardian_name || null,
    guardian_contact: b.guardian_contact || null,
    parent_id: b.parent_id || null,
    diagnosis: b.diagnosis || null,
    therapy_type: b.therapy_type || 'OT',
    status: b.status || 'active'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clients', record_id: data.id, action: 'create',
    description: `Registered client ${fullName} (${client_code})`,
    created_by: req.user.id
  });

  res.status(201).json(data);
});

/**
 * PUT /api/clients/:id, admin/staff can edit the full profile; an ot/speech
 * therapist may only update Development & Functional Information (their own
 * clinical observations), never administrative fields like status, diagnosis,
 * or who's assigned, those stay admin/staff-only.
 */
router.put('/:id', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const isTherapist = ['ot', 'speech'].includes(req.user.role);
  const allowed = isTherapist ? [] : [
    'full_name','first_name','last_name','dob','gender','guardian_name','guardian_contact','parent_id','diagnosis','therapy_type','status','assigned_therapist_name'
  ];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];

  // Development & Functional Information, any of admin/staff/ot/speech may
  // submit this (validated dynamically against the current field definitions,
  // same as self-register), unlike the fields above which stay admin/staff-only.
  if ('dev_functional_data' in req.body) {
    patch.dev_functional_data = await validateDevFunctionalData(req.body.dev_functional_data);
  }

  // Keep the derived full_name in sync when either name part changes.
  if (('first_name' in patch || 'last_name' in patch) && !('full_name' in patch)) {
    const { data: current } = await db.from('clients').select('first_name, last_name').eq('id', req.params.id).single();
    const first = 'first_name' in patch ? patch.first_name : current?.first_name;
    const last = 'last_name' in patch ? patch.last_name : current?.last_name;
    patch.full_name = [first, last].filter(Boolean).join(' ');
  }

  const { data, error } = await db.from('clients').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clients', record_id: req.params.id, action: 'update',
    description: `Updated client profile for ${data.full_name}` + (patch.status ? `, status set to ${patch.status}` : ''),
    updated_by: req.user.id
  });

  res.json(data);
});

/** DELETE /api/clients/:id, admin only */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data: existing } = await db.from('clients').select('full_name').eq('id', req.params.id).maybeSingle();
  const { error } = await db.from('clients').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clients', record_id: req.params.id, action: 'delete',
    description: `Deleted client record${existing?.full_name ? ' for ' + existing.full_name : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

/** POST /api/clients/:id/notes, therapist/admin/staff add a session note */
router.post('/:id/notes', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const b = req.body || {};
  if (!b.domain || b.score == null) return res.status(400).json({ error: 'domain and score are required' });
  const { data, error } = await db.from('session_notes').insert({
    client_id: req.params.id,
    therapist_name: b.therapist_name || req.user.name,
    domain: b.domain,
    session_date: b.session_date || new Date().toISOString().slice(0, 10),
    score: b.score,
    remark: b.remark || null,
    next_plan: b.next_plan || null,
    tags: b.tags || []
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

/** POST /api/clients/:id/attendance, mark attended/missed */
router.post('/:id/attendance', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const b = req.body || {};
  const { data, error } = await db.from('attendance').insert({
    client_id: req.params.id,
    session_date: b.session_date || new Date().toISOString().slice(0, 10),
    attended: b.attended !== false
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

export default router;

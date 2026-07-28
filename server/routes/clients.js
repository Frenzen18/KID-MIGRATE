import { Router } from 'express';
import multer from 'multer';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { nextClientCode } from '../usercode.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent, channelEnabled } from '../lib/notify.js';
import { generateReportSummary } from '../services/gemini.service.js';
import { makeLimiter, isProd, MIN } from '../lib/rateLimit.js';
import { sendMail } from '../mailer.js';
import { sendSms } from '../sms.js';
import { calendarAge } from '../age.js';
import { isValidName, isSafeText } from '../validate.js';
import { deleteInactiveChild } from '../lib/accountCleanup.js';

/** Client IDs carry the enrollment year: CLI-YYYY-NNNN. */
const NEW_CODE_FORMAT = /^CLI-\d{4}-\d{4}$/;

/** Same image-only, 5MB-max upload gate as server/routes/cms.js, kept local since only a client's own photo route needs it here. */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_IMAGE_TYPES.has(file.mimetype))
});

/** Mirrors client/src/components/DevFunctionalField.jsx's LETTERS_ONLY_SECTIONS. */
const LETTERS_ONLY_SECTIONS = ['Behavior & Social', 'Motor Skills'];

/** An 'ot'/'speech' account only ever generates a report for their own discipline's
 *  entries, mirrors server/routes/gas.js's own ROLE_DISCIPLINE map. */
const ROLE_DISCIPLINE = { ot: 'Occupational Therapy', speech: 'Speech-Language Therapy' };

// Each call is a real, billed Gemini request, cap it per IP so the client
// record's "Generate Report" button can't be spammed into a runaway bill.
const reportSummaryLimiter = makeLimiter(isProd ? MIN : 10 * 1000, 10, 'Too many report requests. Please wait a moment and try again.');

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
 * a client-submitted value verbatim. Returns { data } or, if a field an admin
 * marked required is missing, { error: <message> } for the caller to 400 on.
 */
async function validateDevFunctionalData(raw) {
  const input = (raw && typeof raw === 'object') ? raw : {};
  const { data: fields } = await db.from('dev_functional_fields').select('*').eq('active', true);
  const out = {};
  for (const f of fields || []) {
    const val = input[f.id];
    if (val == null || val === '') continue;
    if (f.field_type === 'select') {
      if (Array.isArray(f.options) && f.options.includes(val)) out[f.id] = val;
    } else {
      const trimmed = String(val).trim();
      if (trimmed) {
        // "Behavior & Social"/"Motor Skills" free-text fields (behavior
        // concerns, sensory sensitivities, fine motor concerns, ...) are a
        // write-up, not a value with a legitimate digit, so they're held to
        // the stricter letters-only rule instead of the general safe-text
        // one (mirrors DevFunctionalField.jsx).
        if (LETTERS_ONLY_SECTIONS.includes(f.section)) {
          if (!isValidName(trimmed)) return { error: `"${f.label}" can only contain letters, spaces, hyphens, and apostrophes.` };
        } else if (!isSafeText(trimmed)) {
          return { error: `"${f.label}" can only contain letters, numbers, and common punctuation.` };
        }
        out[f.id] = trimmed;
      }
    }
  }

  // Required fields (admin-configurable via Manage Fields), skipped if hidden
  // by the one conditional dependency the intake form has today: "Primary
  // mode of communication" only shows once "Verbal" is answered "No" (mirrors
  // client/src/components/DevFunctionalField.jsx's devFieldHidden).
  const verbalField = (fields || []).find(f => f.label === 'Verbal');
  for (const f of fields || []) {
    if (!f.required) continue;
    if (f.label === 'Primary mode of communication' && verbalField && out[verbalField.id] !== 'No') continue;
    if (!out[f.id]) return { error: `"${f.label}" is required.` };
  }

  return { data: out };
}

const router = Router();
router.use(requireAuth);

/** GET /api/clients/inactive-review, child records flagged by the
 *  per-child inactivity-cleanup sweep (see server/lib/accountCleanup.js,
 *  sweepInactiveChildren) for staff to look at before anything is actually
 *  deleted. Never auto-deletes. Placed ahead of GET /:id so "inactive-review"
 *  is never swallowed as a client id. */
router.get('/inactive-review', requireRole('admin', 'staff'), async (req, res) => {
  const { data: flagged, error } = await db.from('clients')
    .select('id, full_name, client_code, parent_id, created_at, deletion_flagged_at')
    .not('deletion_flagged_at', 'is', null)
    .order('deletion_flagged_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  if (!flagged?.length) return res.json([]);

  const parentIds = [...new Set(flagged.map(c => c.parent_id).filter(Boolean))];
  const { data: guardians } = await db.from('profiles').select('id, full_name, email, contact').in('id', parentIds);
  const guardianById = Object.fromEntries((guardians || []).map(g => [g.id, g]));

  res.json(flagged.map(c => ({ ...c, guardian: guardianById[c.parent_id] || null })));
});

/** POST /api/clients/inactive-review/:id/confirm-delete, staff-confirmed hard
 *  delete of one flagged child record only, never the guardian's login or
 *  any other linked child. */
router.post('/inactive-review/:id/confirm-delete', requireRole('admin', 'staff'), async (req, res) => {
  const { data: client } = await db.from('clients').select('id, deletion_flagged_at').eq('id', req.params.id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.deletion_flagged_at) return res.status(400).json({ error: 'This child record is not flagged for inactivity review.' });
  try {
    await deleteInactiveChild(client.id, req.user.id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true });
});

/** GET /api/clients?search=&status=&therapy=&archived=, staff/admin/therapist see all; parents see own children */
router.get('/', async (req, res) => {
  let q = db.from('clients').select('*').order('created_at', { ascending: false });
  if (req.user.role === 'parent') q = q.eq('parent_id', req.user.id);
  q = q.eq('archived', req.query.archived === 'true');
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
    db.from('gas_entries').select('*').eq('client_id', client.id).eq('archived', false).order('session_date')
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

/**
 * POST /api/clients/:id/generate-report { from, to }, aggregates this client's
 * GAS entries over a date range and asks Gemini for a "Therapist Summary &
 * Recommendations" section, the same clinical-data-only, identity-withheld
 * contract as POST /gas/ai-summary, the child's name/code is never sent, the
 * model only ever sees T-scores, goal titles, and score levels.
 */
router.post('/:id/generate-report', reportSummaryLimiter, requireRole('ot', 'speech'), async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required' });
  if (from > to) return res.status(400).json({ error: '"From" date must be before "To" date.' });

  const { data: client } = await db.from('clients').select('id').eq('id', req.params.id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const lockedDiscipline = ROLE_DISCIPLINE[req.user.role];
  let q = db.from('gas_entries').select('*').eq('client_id', client.id).eq('archived', false)
    .gte('session_date', from).lte('session_date', to).order('session_date', { ascending: true });
  if (lockedDiscipline) q = q.eq('discipline', lockedDiscipline);
  const { data: gasEntries, error: gasErr } = await q;
  if (gasErr) return res.status(500).json({ error: gasErr.message });
  if (!gasEntries?.length) return res.status(400).json({ error: 'No session entries found in that date range to summarize.' });

  const { data: scores } = await db.from('gas_entry_scores').select('*').in('entry_id', gasEntries.map(e => e.id));

  // Each goal's level across every session it was scored in, oldest first,
  // so the AI (and the on-screen report) can see the actual trajectory, not
  // just a final number.
  const goalsByTitle = {};
  for (const s of scores || []) {
    const g = (goalsByTitle[s.item_title] ||= { title: s.item_title, weight: s.weight, levels: [] });
    g.levels.push(s.level);
  }
  const goalTrends = Object.values(goalsByTitle);

  const tScores = gasEntries.map(e => e.gas_t_score).filter(v => v != null);
  const avgTScore = tScores.length ? Math.round((tScores.reduce((s, v) => s + v, 0) / tScores.length) * 10) / 10 : null;
  const trend = tScores.length < 2 ? 'insufficient data'
    : tScores[tScores.length - 1] > tScores[0] ? 'improving'
    : tScores[tScores.length - 1] < tScores[0] ? 'declining' : 'stable';
  const disciplines = [...new Set(gasEntries.map(e => e.discipline))];

  let ai;
  try {
    ai = await generateReportSummary({
      disciplines, fromDate: from, toDate: to, sessionCount: gasEntries.length,
      avgTScore, trend, goalTrends
    });
  } catch (e) {
    return res.status(502).json({ error: 'AI summary generation failed: ' + e.message });
  }

  await logAudit({
    table_name: 'clients', record_id: client.id, action: 'update',
    description: `Generated a therapist report (${from} to ${to}) for a client record`,
    created_by: req.user.id
  });

  res.json({
    range: { from, to },
    session_count: gasEntries.length,
    avg_t_score: avgTScore,
    trend,
    disciplines,
    goal_trends: goalTrends,
    summary: ai.summary || '',
    recommendations: ai.recommendations || ''
  });
});

/**
 * POST /api/clients/:id/notify-report-ready { from, to, summary, recommendations },
 * lets the guardian know their (possibly earlier-requested) progress report is
 * ready, by email and/or SMS per the clinic's notification channel settings,
 * plus the usual in-app notification. `summary`/`recommendations` are the
 * therapist's own final text (the AI draft, edited or not), never regenerated
 * here, this endpoint only delivers what the therapist already reviewed.
 */
router.post('/:id/notify-report-ready', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const { from, to, summary, recommendations } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to dates are required' });

  const { data: client } = await db.from('clients').select('id, full_name, parent_id, guardian_contact').eq('id', req.params.id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.parent_id) return res.status(400).json({ error: 'This client has no linked guardian account to notify.' });

  const { data: guardian } = await db.from('profiles').select('email, full_name, contact').eq('id', client.parent_id).maybeSingle();

  const periodLabel = `${from} to ${to}`;
  let emailSent = false, smsSent = false;

  if (guardian?.email && await channelEnabled('channel_email')) {
    try {
      await sendMail({
        to: guardian.email,
        subject: `Progress Report Ready: ${client.full_name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
            <div style="text-align: center; margin-bottom: 20px;"><h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2></div>
            <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px;">
              <p style="color: #334155; font-size: 14px; margin: 0 0 12px;">Hi ${guardian.full_name || 'there'},</p>
              <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">${client.full_name}'s progress report for ${periodLabel} is ready.</p>
              ${summary ? `<p style="color: #64748B; font-size: 13px; margin: 0 0 10px;"><b>Summary:</b> ${summary}</p>` : ''}
              ${recommendations ? `<p style="color: #64748B; font-size: 13px; margin: 0 0 10px;"><b>Recommendations:</b> ${recommendations}</p>` : ''}
              <p style="color: #94A3B8; font-size: 12px; margin: 16px 0 0;">Please contact the clinic for the full printed copy and any related fees.</p>
            </div>
          </div>
        `
      });
      emailSent = true;
    } catch (e) {
      console.error('notify-report-ready email failed:', e.message);
    }
  }

  if (client.guardian_contact && await channelEnabled('channel_sms')) {
    try {
      await sendSms({
        to: client.guardian_contact,
        message: `Hi! ${client.full_name}'s progress report for ${periodLabel} is ready. Please contact the clinic for the full copy. KID Clinic`
      });
      smsSent = true;
    } catch (e) {
      console.error('notify-report-ready SMS failed:', e.message);
    }
  }

  await notifyEvent(null, {
    title: 'Progress report ready',
    body: `${client.full_name}'s progress report for ${periodLabel} is ready.`,
    icon: 'fa-file-circle-check',
    target_user: client.parent_id
  });

  await logAudit({
    table_name: 'clients', record_id: client.id, action: 'update',
    description: `Notified guardian that the progress report (${periodLabel}) for ${client.full_name} is ready`,
    updated_by: req.user.id
  });

  res.json({ ok: true, emailSent, smsSent });
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
  if (!isValidName(childFirst) || !isValidName(childLast) || (childMiddle && !isValidName(childMiddle))) {
    return res.status(400).json({ error: 'Names can only contain letters, spaces, hyphens, and apostrophes.' });
  }
  const childFull = childMiddle ? `${childFirst} ${childMiddle} ${childLast}` : `${childFirst} ${childLast}`;
  if (!b.dob) return res.status(400).json({ error: 'Date of birth is required.' });
  if (!b.gender) return res.status(400).json({ error: 'Gender is required.' });

  // Patients must be 3–21 years old.
  const dobMs = new Date(b.dob).getTime();
  if (isNaN(dobMs) || dobMs > Date.now()) return res.status(400).json({ error: 'Date of birth is invalid.' });
  const childAge = calendarAge(b.dob);
  if (childAge < 3 || childAge > 21) {
    return res.status(400).json({ error: 'Patients must be between 3 and 21 years old.' });
  }

  // Guardian must be an adult, validated from date of birth, same as the child.
  if (!b.guardian_dob) return res.status(400).json({ error: 'Guardian/caretaker date of birth is required.' });
  const guardianDobMs = new Date(b.guardian_dob).getTime();
  if (isNaN(guardianDobMs) || guardianDobMs > Date.now()) {
    return res.status(400).json({ error: 'Guardian/caretaker date of birth is invalid.' });
  }
  const guardianAge = calendarAge(b.guardian_dob);
  if (guardianAge < 18 || guardianAge > 120) {
    return res.status(400).json({ error: 'Parent/guardian age must be 18 or older.' });
  }

  // Philippine mobile format: +639XXXXXXXXX only.
  const PH_PHONE = /^\+639\d{9}$/;
  if (b.guardian_phone && !PH_PHONE.test(b.guardian_phone)) {
    return res.status(400).json({ error: 'Contact number must start with +63 followed by the mobile number (e.g. +639171234567).' });
  }
  if (b.other_guardian_phone && !PH_PHONE.test(b.other_guardian_phone)) {
    return res.status(400).json({ error: 'Alternate contact number must start with 09 or +63.' });
  }
  if ((b.guardian_name && !isValidName(b.guardian_name)) || (b.other_guardian_name && !isValidName(b.other_guardian_name))) {
    return res.status(400).json({ error: 'Names can only contain letters, spaces, hyphens, and apostrophes.' });
  }
  if ((b.allergies && !isSafeText(b.allergies)) || (b.daily_medication && !isSafeText(b.daily_medication))) {
    return res.status(400).json({ error: 'Allergies and Daily Medication can only contain letters, numbers, and common punctuation.' });
  }

  const relationship = ['Parent', 'Guardian', 'Caretaker'].includes(b.guardian_relationship)
    ? b.guardian_relationship : 'Parent';

  // Development & Functional Information, optional by default (parents may not
  // know the answer yet at intake) unless an admin marked a field required,
  // validated dynamically against the admin-configurable field list rather
  // than a fixed set of columns.
  const devResult = await validateDevFunctionalData(b.dev_functional_data);
  if (devResult.error) return res.status(400).json({ error: devResult.error });
  const dev_functional_data = devResult.data;

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
  if (!isValidName(first) || (last_ && !isValidName(last_)) || (b.guardian_name && !isValidName(b.guardian_name))) {
    return res.status(400).json({ error: 'Names can only contain letters, spaces, hyphens, and apostrophes.' });
  }
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
    therapy_type: b.therapy_type || null, // set by the clinic after assessment
    assigned_ot_therapist_name: b.assigned_ot_therapist_name || null,
    assigned_speech_therapist_name: b.assigned_speech_therapist_name || null,
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
 * clinical observations), never administrative fields like status or who's
 * assigned, those stay admin/staff-only.
 */
router.put('/:id', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const isTherapist = ['ot', 'speech'].includes(req.user.role);
  const allowed = isTherapist ? [] : [
    'full_name','first_name','last_name','dob','gender','guardian_name','guardian_contact','parent_id','therapy_type','status','assigned_ot_therapist_name','assigned_speech_therapist_name',
    'recommended_ot_weekly_sessions','recommended_speech_weekly_sessions','initial_assessment_completed'
  ];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];

  for (const k of ['full_name', 'first_name', 'last_name', 'guardian_name']) {
    if (patch[k] && !isValidName(patch[k])) {
      return res.status(400).json({ error: 'Names can only contain letters, spaces, hyphens, and apostrophes.' });
    }
  }

  for (const k of ['recommended_ot_weekly_sessions', 'recommended_speech_weekly_sessions']) {
    if (k in patch && patch[k] !== null) {
      const n = Number(patch[k]);
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        return res.status(400).json({ error: 'Recommended weekly sessions must be a whole number between 1 and 7.' });
      }
      patch[k] = n;
    }
  }

  // Development & Functional Information, any of admin/staff/ot/speech may
  // submit this (validated dynamically against the current field definitions,
  // same as self-register), unlike the fields above which stay admin/staff-only.
  if ('dev_functional_data' in req.body) {
    const devResult = await validateDevFunctionalData(req.body.dev_functional_data);
    if (devResult.error) return res.status(400).json({ error: devResult.error });
    patch.dev_functional_data = devResult.data;
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
    description: `Updated client profile for ${data.full_name}` + (patch.status ? `, status set to ${patch.status}` : '')
      + ('initial_assessment_completed' in patch ? `, Initial Assessment manually marked ${patch.initial_assessment_completed ? 'completed' : 'not completed'}` : ''),
    updated_by: req.user.id
  });

  res.json(data);
});

/**
 * POST /api/clients/:id/photo, upload/replace a child's profile photo. A
 * guardian may only upload for their own child, so the therapist looking
 * after them can recognize their face; admin/staff can upload for any client.
 */
router.post('/:id/photo', (req, res, next) => {
  photoUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Only JPEG, PNG, GIF, or WEBP images are allowed (max 5MB).' });
  if (!['parent', 'admin', 'staff'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed to upload a photo for this client.' });
  }

  const { data: client } = await db.from('clients').select('id, parent_id, full_name').eq('id', req.params.id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (req.user.role === 'parent' && client.parent_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your child record' });
  }

  // Extension derived from the validated MIME type, not the client-supplied
  // filename, avoids storing a file whose extension/content type disagree.
  const EXT_FOR_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  const ext = EXT_FOR_TYPE[req.file.mimetype] || 'jpg';
  const path = `clients/${req.params.id}-${Date.now()}.${ext}`;

  const { error: upErr } = await db.storage.from('uploads').upload(path, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: false
  });
  if (upErr) return res.status(500).json({ error: 'Failed to upload: ' + upErr.message });

  const { data: urlData } = db.storage.from('uploads').getPublicUrl(path);
  const { data, error } = await db.from('clients').update({ photo_url: urlData.publicUrl }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clients', record_id: req.params.id, action: 'update',
    description: `Updated profile photo for ${client.full_name}`,
    updated_by: req.user.id
  });

  res.json(data);
});

/**
 * POST /api/clients/:id/request-progress-report, guardian requests a written
 * progress report for their child. Per the clinic's Memorandum of Agreement,
 * progress reports carry their own fee (₱1,000, +₱500 for a rush request)
 * settled directly between the family and the clinic, this endpoint only
 * relays the request to staff/admin, it never generates the report or
 * collects payment itself.
 */
router.post('/:id/request-progress-report', async (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ error: 'Only a guardian can request a progress report.' });

  const { data: client } = await db.from('clients').select('id, parent_id, full_name').eq('id', req.params.id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (client.parent_id !== req.user.id) return res.status(403).json({ error: 'Not your child record' });

  // req.user.name reflects Supabase Auth's user_metadata (see middleware/auth.js),
  // which mirrors profiles.full_name but can lag behind it, prefer the fresh column.
  const { data: requesterProfile } = await db.from('profiles').select('full_name').eq('id', req.user.id).maybeSingle();
  const body = `${requesterProfile?.full_name || req.user.name || 'A guardian'} requested a written progress report for ${client.full_name}. Fees and delivery are arranged directly with the family.`;
  await notifyEvent(null, { title: 'Progress report requested', body, icon: 'fa-file-medical', target_role: 'admin' });
  await notifyEvent(null, { title: 'Progress report requested', body, icon: 'fa-file-medical', target_role: 'staff' });

  await logAudit({
    table_name: 'clients', record_id: client.id, action: 'update',
    description: `Guardian requested a progress report for ${client.full_name}`,
    created_by: req.user.id
  });

  res.json({ ok: true });
});

/**
 * Bucket the archived-record snapshot is uploaded to on DELETE /:id and read
 * back from on GET /:id/archive-file, a full point-in-time backup of the
 * client's record (profile + clinical history), separate from the DB row
 * itself, which stays in place (archived: true) so Restore is instant.
 */
const ARCHIVE_BUCKET = 'Client Records';

/** Gathers everything DELETE /:id archives, one full JSON snapshot of a client's record. */
async function buildClientSnapshot(clientId) {
  const [{ data: client }, { data: notes }, { data: attendance }, { data: gasEntries }, { data: reservations }, { data: payments }] = await Promise.all([
    db.from('clients').select('*').eq('id', clientId).single(),
    db.from('session_notes').select('*').eq('client_id', clientId),
    db.from('attendance').select('*').eq('client_id', clientId),
    db.from('gas_entries').select('*').eq('client_id', clientId),
    db.from('reservations').select('*').eq('client_id', clientId),
    db.from('payments').select('*').eq('client_id', clientId)
  ]);
  if (!client) return null;

  let gas_entry_scores = [];
  if (gasEntries?.length) {
    const { data: scores } = await db.from('gas_entry_scores').select('*').in('entry_id', gasEntries.map(e => e.id));
    gas_entry_scores = scores || [];
  }

  return {
    snapshot_taken_at: new Date().toISOString(),
    client,
    session_notes: notes || [],
    attendance: attendance || [],
    gas_entries: gasEntries || [],
    gas_entry_scores,
    reservations: reservations || [],
    payments: payments || []
  };
}

/** DELETE /api/clients/:id, admin only, archive a client profile: backs up the full record to
 *  Storage (bucket "Client Records") and flags the row archived (soft delete, all associated
 *  records are kept in the DB too, so Restore is instant). */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data: existing } = await db.from('clients').select('full_name, client_code').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const snapshot = await buildClientSnapshot(req.params.id);
  const path = `${existing.client_code || req.params.id}.json`;
  const { error: upErr } = await db.storage.from(ARCHIVE_BUCKET).upload(path, Buffer.from(JSON.stringify(snapshot, null, 2)), {
    contentType: 'application/json',
    upsert: true
  });
  if (upErr) return res.status(500).json({ error: 'Failed to back up record: ' + upErr.message });

  const { error } = await db.from('clients').update({ archived: true, archive_snapshot_path: path }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clients', record_id: req.params.id, action: 'archive',
    description: `Archived client record${existing?.full_name ? ' for ' + existing.full_name : ''} (backed up to Storage)`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

/** PUT /api/clients/:id/restore, admin only, un-archives a client, the row and all its
 *  clinical history were never removed, so this just flips the flag back. */
router.put('/:id/restore', requireRole('admin'), async (req, res) => {
  const { data: existing } = await db.from('clients').select('full_name').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Client not found' });

  const { error } = await db.from('clients').update({ archived: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clients', record_id: req.params.id, action: 'restore',
    description: `Restored client record${existing?.full_name ? ' for ' + existing.full_name : ''} from archive`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

/** GET /api/clients/:id/archive-file, admin only, a short-lived signed URL to download the
 *  Storage backup taken when this client was last archived (the bucket isn't public). */
router.get('/:id/archive-file', requireRole('admin'), async (req, res) => {
  const { data: client } = await db.from('clients').select('archive_snapshot_path').eq('id', req.params.id).maybeSingle();
  if (!client?.archive_snapshot_path) return res.status(404).json({ error: 'No backup on file for this client yet.' });

  const { data, error } = await db.storage.from(ARCHIVE_BUCKET).createSignedUrl(client.archive_snapshot_path, 60);
  if (error) return res.status(500).json({ error: 'Failed to generate download link: ' + error.message });

  res.json({ url: data.signedUrl });
});

/** POST /api/clients/:id/notes, therapist/admin/staff add a session note */
router.post('/:id/notes', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const b = req.body || {};
  if (!b.domain || b.score == null) return res.status(400).json({ error: 'domain and score are required' });
  // A therapist logging their own note without an explicit therapist_name gets
  // stamped with their own name here, permanently, this must be the fresh
  // profiles.full_name, not req.user.name (Auth's user_metadata mirror, which
  // can lag behind it) or a stale name gets baked into this row forever and
  // vanishes from that therapist's own Milestone Scoreboard/GAS history.
  let authorName = b.therapist_name;
  if (!authorName) {
    const { data: authorProfile } = await db.from('profiles').select('full_name').eq('id', req.user.id).maybeSingle();
    authorName = authorProfile?.full_name || req.user.name;
  }
  const { data, error } = await db.from('session_notes').insert({
    client_id: req.params.id,
    therapist_name: authorName,
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

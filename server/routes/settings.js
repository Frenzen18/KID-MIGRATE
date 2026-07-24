import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// accent_color, tagline, phone, hours_weekdays, hours_saturday, website_url, and
// email were removed from Settings, they saved but had no effect anywhere in the
// app (no CSS consumed accent_color, nothing displayed tagline/phone/hours/website
// copy, outgoing mail uses SMTP_EMAIL from env not this field). Existing DB
// columns are left in place, just no longer editable.
const BRANDING_FIELDS = [
  'clinic_name', 'address', 'logo_url', 'favicon_url', 'login_bg_url',
  'primary_color', 'secondary_color', 'background_color', 'card_color', 'text_color',
  'navbar_bg_color', 'navbar_text_color', 'navbar_hover_color', 'footer_bg_color', 'footer_text_color',
  'landing_primary_color', 'landing_navbar_bg_color', 'landing_background_color',
  'font_family', 'font_size'
];
const COLOR_FIELDS = [
  'primary_color', 'secondary_color', 'background_color', 'card_color', 'text_color',
  'navbar_bg_color', 'navbar_text_color', 'navbar_hover_color', 'footer_bg_color', 'footer_text_color',
  'landing_primary_color', 'landing_navbar_bg_color', 'landing_background_color'
];
// Must match the fonts loaded in client/index.html and Branding.jsx's FONT_OPTIONS.
const FONT_FAMILIES = new Set([
  'Inter', 'Poppins', 'DM Sans', 'Karla', 'Roboto', 'Open Sans', 'Lato', 'Montserrat',
  'Nunito', 'Raleway', 'Work Sans', 'Source Sans 3', 'Merriweather', 'Playfair Display',
  'Quicksand', 'Rubik', 'Manrope', 'Outfit', 'Plus Jakarta Sans', 'Space Grotesk',
  'Lexend', 'Urbanist', 'Mulish', 'Baloo 2'
]);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** PUBLIC: GET /api/settings/branding/public, read-only, no auth. Lets the
 * theme (colors/logo/favicon/font) apply on pages nobody is logged in on yet
 * (landing page, login screens) before the admin-gated routes below. */
router.get('/branding/public', async (req, res) => {
  const { data, error } = await db.from('branding_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const HOURS_FIELDS = ['clinic_weekday_start_hour', 'clinic_weekday_end_hour', 'clinic_saturday_start_hour', 'clinic_saturday_end_hour'];

/** GET /api/settings/hours, admin+staff (same access level as therapist shift scheduling,
 * since clinic operating hours live on the Employee Scheduling tab). These are the
 * *functional* hours Initial Assessment slots are generated from (see
 * server/routes/reservations.js's getClinicHours()), separate from the free-text
 * hours_weekdays/hours_saturday marketing copy shown in Settings & Branding. */
router.get('/hours', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { data, error } = await db.from('branding_settings').select(HOURS_FIELDS.join(', ')).eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** PUT /api/settings/hours, admin+staff can edit just the clinic operating hours
 * from Employee Scheduling, without needing the full branding-admin permission the rest
 * of Settings (colors, logo, etc.) requires. */
router.put('/hours', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of HOURS_FIELDS) {
    if (!(k in b)) continue;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      return res.status(400).json({ error: `${k.replace(/_/g, ' ')} must be an hour between 0 and 23` });
    }
    patch[k] = n;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  const startEndPairs = [
    ['clinic_weekday_start_hour', 'clinic_weekday_end_hour'],
    ['clinic_saturday_start_hour', 'clinic_saturday_end_hour']
  ];
  if (startEndPairs.some(([s, e]) => s in patch && e in patch && patch[s] >= patch[e])) {
    return res.status(400).json({ error: 'Opening hour must be before closing hour' });
  }

  patch.updated_at = new Date().toISOString();
  patch.updated_by = req.user.id;

  const { data, error } = await db.from('branding_settings').update(patch).eq('id', 1).select(HOURS_FIELDS.join(', ')).single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'branding_settings', record_id: 1, action: 'update',
    description: 'Updated clinic operating hours',
    updated_by: req.user.id
  });

  res.json(data);
});

/** GET /api/settings/holidays?from=&to=, any authenticated role (guardians need this
 * too, to understand why a date can't be booked), upcoming clinic-wide closures
 * (specific one-off dates, e.g. holidays), separate from the weekly weekday/Saturday
 * hours pattern. No booking of any kind (Initial Assessment or shift-driven sessions)
 * is allowed on a holiday, see server/routes/reservations.js's isClinicHoliday(). */
router.get('/holidays', requireAuth, async (req, res) => {
  let q = db.from('clinic_holidays').select('*').order('date');
  if (req.query.from) q = q.gte('date', req.query.from);
  if (req.query.to) q = q.lte('date', req.query.to);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** POST /api/settings/holidays  { date, label? }, admin+staff. */
router.post('/holidays', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { date, label } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid date is required' });
  }
  const { data, error } = await db.from('clinic_holidays')
    .insert({ date, label: (label || '').trim() || null, created_by: req.user.id })
    .select().single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That date is already marked as a closure' });
    return res.status(500).json({ error: error.message });
  }

  await logAudit({
    table_name: 'clinic_holidays', record_id: data.id, action: 'create',
    description: `Marked ${date} as a clinic closure${label ? ` (${label})` : ''}`,
    created_by: req.user.id
  });

  res.status(201).json(data);
});

/** DELETE /api/settings/holidays/:id, admin+staff. */
router.delete('/holidays/:id', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { data: existing } = await db.from('clinic_holidays').select('date, label').eq('id', req.params.id).maybeSingle();
  const { error } = await db.from('clinic_holidays').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'clinic_holidays', record_id: req.params.id, action: 'delete',
    description: `Removed clinic closure${existing ? ` (${existing.date}${existing.label ? ', ' + existing.label : ''})` : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

router.use(requireAuth, requireRole('admin'));

/** GET /api/settings/branding */
router.get('/branding', async (req, res) => {
  const { data, error } = await db.from('branding_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** PUT /api/settings/branding */
router.put('/branding', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of BRANDING_FIELDS) if (k in b) patch[k] = b[k];

  if (!('clinic_name' in patch) || !String(patch.clinic_name || '').trim()) {
    return res.status(400).json({ error: 'Clinic name is required' });
  }
  for (const k of COLOR_FIELDS) {
    if (patch[k] && !HEX_COLOR.test(patch[k])) {
      return res.status(400).json({ error: `${k.replace(/_/g, ' ')} must be a hex color like #0EA5E9` });
    }
  }
  if (patch.font_family && !FONT_FAMILIES.has(patch.font_family)) {
    return res.status(400).json({ error: 'Unsupported font family' });
  }
  if ('font_size' in patch) {
    const n = Number(patch.font_size);
    if (!Number.isInteger(n) || n < 12 || n > 24) {
      return res.status(400).json({ error: 'Font size must be a whole number between 12 and 24' });
    }
    patch.font_size = n;
  }

  patch.updated_at = new Date().toISOString();
  patch.updated_by = req.user.id;

  const { data, error } = await db.from('branding_settings').update(patch).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'branding_settings', record_id: 1, action: 'update',
    description: 'Updated clinic branding & information settings',
    updated_by: req.user.id
  });

  res.json(data);
});

export default router;

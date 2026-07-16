import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();

// accent_color and tagline were removed, they saved but had no effect
// anywhere in the app (no CSS consumed accent_color, nothing displayed
// tagline). Existing DB columns are left in place, just no longer editable.
const BRANDING_FIELDS = [
  'clinic_name', 'address', 'phone', 'email', 'hours_weekdays', 'hours_saturday',
  'website_url', 'logo_url', 'favicon_url', 'login_bg_url',
  'primary_color', 'secondary_color', 'background_color', 'card_color', 'text_color',
  'navbar_bg_color', 'navbar_text_color', 'navbar_hover_color', 'footer_bg_color', 'footer_text_color',
  'landing_primary_color', 'landing_navbar_bg_color', 'landing_background_color',
  'font_family'
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
  if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
    return res.status(400).json({ error: 'Email is not valid' });
  }
  if (patch.font_family && !FONT_FAMILIES.has(patch.font_family)) {
    return res.status(400).json({ error: 'Unsupported font family' });
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

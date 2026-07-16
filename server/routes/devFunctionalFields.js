import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

const FIELD_TYPES = ['select', 'text', 'select_other'];
// 'select_other' is a dropdown plus an implicit trailing "Others" option that
// reveals a free-text box, needs the same >=2 curated options as 'select'.
const NEEDS_OPTIONS = ['select', 'select_other'];

/**
 * GET /api/dev-functional-fields, active fields, ordered for rendering.
 * Every authenticated role can read this: parents need it to render the
 * "Development & Functional Information" section of the child-linking form,
 * admin/staff/therapists need it to render/edit it in Client Records.
 */
router.get('/', async (req, res) => {
  const { data, error } = await db.from('dev_functional_fields').select('*').eq('active', true).order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/** GET /api/dev-functional-fields/all, admin-only, includes deactivated fields (Form Builder view) */
router.get('/all', requireRole('admin'), async (req, res) => {
  const { data, error } = await db.from('dev_functional_fields').select('*').order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/** POST /api/dev-functional-fields, admin adds a new field to the form */
router.post('/', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.section?.trim() || !b.label?.trim()) return res.status(400).json({ error: 'Section and label are required' });
  if (!FIELD_TYPES.includes(b.field_type)) return res.status(400).json({ error: 'field_type must be "select", "text", or "select_other"' });
  const options = NEEDS_OPTIONS.includes(b.field_type) ? (Array.isArray(b.options) ? b.options.map(o => String(o).trim()).filter(Boolean) : []) : null;
  if (NEEDS_OPTIONS.includes(b.field_type) && options.length < 2) return res.status(400).json({ error: 'This field type needs at least 2 options' });

  const { data: maxRow } = await db.from('dev_functional_fields').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sort_order = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : ((maxRow?.sort_order ?? 0) + 1);

  const { data, error } = await db.from('dev_functional_fields').insert({
    section: b.section.trim(), label: b.label.trim(), field_type: b.field_type, options, required: b.required === true, sort_order, updated_by: req.user.id
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'dev_functional_fields', record_id: data.id, action: 'create',
    description: `Added Development & Functional field "${data.label}" (${data.section})`,
    created_by: req.user.id
  });
  res.status(201).json(data);
});

/** PUT /api/dev-functional-fields/:id, admin edits a field (rename, re-type, reorder, activate/deactivate) */
router.put('/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const { data: existing, error: exErr } = await db.from('dev_functional_fields').select('*').eq('id', req.params.id).maybeSingle();
  if (exErr || !existing) return res.status(404).json({ error: 'Field not found' });

  const patch = {};
  if ('section' in b) patch.section = String(b.section).trim();
  if ('label' in b) patch.label = String(b.label).trim();
  if ('field_type' in b) {
    if (!FIELD_TYPES.includes(b.field_type)) return res.status(400).json({ error: 'field_type must be "select", "text", or "select_other"' });
    patch.field_type = b.field_type;
  }
  if ('options' in b) patch.options = Array.isArray(b.options) ? b.options.map(o => String(o).trim()).filter(Boolean) : null;
  if ('required' in b) patch.required = b.required === true;
  if ('sort_order' in b) patch.sort_order = Number(b.sort_order) || 0;
  if ('active' in b) patch.active = b.active === true;

  const finalType = patch.field_type || existing.field_type;
  const finalOptions = 'options' in patch ? patch.options : existing.options;
  if (NEEDS_OPTIONS.includes(finalType) && (!Array.isArray(finalOptions) || finalOptions.length < 2)) {
    return res.status(400).json({ error: 'This field type needs at least 2 options' });
  }

  patch.updated_at = new Date().toISOString();
  patch.updated_by = req.user.id;

  const { data, error } = await db.from('dev_functional_fields').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'dev_functional_fields', record_id: req.params.id, action: 'update',
    description: `Updated Development & Functional field "${data.label}"`,
    updated_by: req.user.id
  });
  res.json(data);
});

/**
 * DELETE /api/dev-functional-fields/:id, admin removes a field from the form.
 * Soft-delete (active: false): already-collected client data for this field
 * is kept in place, it just stops appearing on new forms/edits.
 */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data, error } = await db.from('dev_functional_fields')
    .update({ active: false, updated_at: new Date().toISOString(), updated_by: req.user.id })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'dev_functional_fields', record_id: req.params.id, action: 'delete',
    description: `Removed Development & Functional field "${data?.label || req.params.id}"`,
    updated_by: req.user.id
  });
  res.json({ ok: true });
});

export default router;

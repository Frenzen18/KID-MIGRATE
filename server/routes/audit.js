import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'staff'));

/**
 * GET /api/audit?table=&action=&from=&to=&user=&limit=, the full
 * created_by/updated_by/approved_by trail, same for admin and staff.
 * `user` filters to events performed BY that user (as creator, updater, or
 * approver), powers the "click a name" per-user activity view.
 */
router.get('/', async (req, res) => {
  let q = db.from('audit_logs')
    .select('*, creator:profiles!created_by(id, full_name), updater:profiles!updated_by(id, full_name), approver:profiles!approved_by(id, full_name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit, 10) || 200, 500));
  if (req.query.table) q = q.eq('table_name', req.query.table);
  if (req.query.action) q = q.eq('action', req.query.action);
  if (req.query.from) q = q.gte('created_at', req.query.from);
  if (req.query.to) q = q.lte('created_at', req.query.to);
  if (req.query.user) q = q.or(`created_by.eq.${req.query.user},updated_by.eq.${req.query.user},approved_by.eq.${req.query.user}`);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * GET /api/audit/user/:id/summary, per-user activity snapshot for the "click
 * a name" panel: who they are, how many times they've logged in (only counts
 * from whenever login tracking was added, no historical backfill), and a
 * breakdown of record actions they've performed.
 */
router.get('/user/:id/summary', async (req, res) => {
  const { data: profile, error: profileErr } = await db.from('profiles').select('id, full_name, role, email, active').eq('id', req.params.id).maybeSingle();
  if (profileErr) return res.status(500).json({ error: profileErr.message });
  if (!profile) return res.status(404).json({ error: 'User not found' });

  const { data: rows, error } = await db.from('audit_logs')
    .select('action, created_by, updated_by, approved_by')
    .or(`created_by.eq.${req.params.id},updated_by.eq.${req.params.id},approved_by.eq.${req.params.id}`);
  if (error) return res.status(500).json({ error: error.message });

  const action_counts = { create: 0, update: 0, delete: 0, approve: 0, archive: 0 };
  let login_count = 0;
  for (const r of rows || []) {
    if (r.action === 'login') {
      if (r.created_by === req.params.id) login_count++;
    } else if (action_counts[r.action] != null) {
      action_counts[r.action]++;
    }
  }

  res.json({ profile, login_count, action_counts, total_actions: (rows || []).length - login_count });
});

export default router;

import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'staff'));

/** GET /api/audit?table=&action=&from=&to=&limit=, the full created_by/updated_by/approved_by trail, same for admin and staff. */
router.get('/', async (req, res) => {
  let q = db.from('audit_logs')
    .select('*, creator:profiles!created_by(full_name), updater:profiles!updated_by(full_name), approver:profiles!approved_by(full_name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit, 10) || 200, 500));
  if (req.query.table) q = q.eq('table_name', req.query.table);
  if (req.query.action) q = q.eq('action', req.query.action);
  if (req.query.from) q = q.gte('created_at', req.query.from);
  if (req.query.to) q = q.lte('created_at', req.query.to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;

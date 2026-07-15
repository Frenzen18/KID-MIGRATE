import { db } from '../supabase.js';

/**
 * Records one audit-trail event (create/update/approve/delete) with who did it
 * and when. Never throws, a logging failure must not break the caller's request.
 */
export async function logAudit({ table_name, record_id, action, description, created_by, updated_by, approved_by }) {
  const row = {
    table_name,
    record_id: record_id != null ? String(record_id) : null,
    action,
    description: description || null
  };
  if (created_by) row.created_by = created_by;
  if (updated_by) { row.updated_by = updated_by; row.updated_at = new Date().toISOString(); }
  if (approved_by) { row.approved_by = approved_by; row.approved_at = new Date().toISOString(); }

  const { error } = await db.from('audit_logs').insert(row);
  if (error) console.error('audit log failed:', error.message);
}

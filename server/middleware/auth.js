import { db } from '../supabase.js';

/** Verifies the Bearer token with Supabase Auth and attaches req.user = { id, email, role, name }. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired token' });

  // Role is authorization-critical, so it must come from app_metadata, unlike
  // user_metadata, only the service-role key (this server) can write that field.
  // A user can self-edit their own user_metadata via the Supabase client SDK,
  // so trusting role from there would let anyone grant themselves admin.
  const meta = data.user.user_metadata || {};
  req.user = {
    id: data.user.id,
    email: data.user.email,
    role: data.user.app_metadata?.role || 'parent',
    name: meta.full_name || data.user.email
  };
  next();
}

/** Role guard: requireRole('admin','staff') */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: requires role ' + roles.join(' or ') });
    }
    next();
  };
}

import { db } from './supabase.js';

/**
 * DB-backed store for email-verification / password-reset codes (table:
 * verification_codes). Previously these lived only in a server-memory Map,
 * so any restart between sending a code and the user entering it wiped it,
 * "Invalid or expired code" even when typed correctly within the TTL.
 */

/** Create/replace the pending code for (email, purpose); one row per pair, a new code replaces the old one. */
export async function setCode({ email, purpose, code, expiresAt, userId = null, fullName = null }) {
  const { error } = await db.from('verification_codes').upsert({
    email: email.trim().toLowerCase(),
    purpose,
    code,
    user_id: userId,
    full_name: fullName,
    expires_at: new Date(expiresAt).toISOString(),
    created_at: new Date().toISOString()
  }, { onConflict: 'email,purpose' });
  if (error) throw new Error(error.message);
}

/** Fetch the pending code row for (email, purpose), or null if none exists. */
export async function getCode(email, purpose) {
  const { data, error } = await db.from('verification_codes')
    .select('*').eq('email', email.trim().toLowerCase()).eq('purpose', purpose).maybeSingle();
  // A real DB error (e.g. the table is missing) must not look like "no code
  // found", that would silently turn into a wrong "invalid or expired code"
  // for every attempt instead of a loud, fixable failure.
  if (error) throw new Error(error.message);
  return data || null;
}

export async function deleteCode(email, purpose) {
  const { error } = await db.from('verification_codes').delete().eq('email', email.trim().toLowerCase()).eq('purpose', purpose);
  if (error) throw new Error(error.message);
}

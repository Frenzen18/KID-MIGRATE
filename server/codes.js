import { db } from './supabase.js';

/**
 * DB-backed store for email-verification / password-reset codes (table:
 * verification_codes). Previously these lived only in a server-memory Map,
 * so any restart between sending a code and the user entering it wiped it,
 * "Invalid or expired code" even when typed correctly within the TTL.
 *
 * Keyed by EITHER email or phone (never both), a phone-only account (see
 * server/phone.js) has no real email to send a code to, so the same
 * email_verify / password_reset flow needs to work keyed by phone instead.
 * Exactly one of `email`/`phone` is expected on every call, callers resolve
 * which one applies before reaching here (see resolveIdentifier in auth.js).
 */

/** Create/replace the pending code for (email|phone, purpose); one row per pair, a new code replaces the old one. */
export async function setCode({ email, phone, purpose, code, expiresAt, userId = null, fullName = null }) {
  const row = {
    purpose, code, user_id: userId, full_name: fullName,
    expires_at: new Date(expiresAt).toISOString(), created_at: new Date().toISOString()
  };
  if (email) row.email = email.trim().toLowerCase();
  if (phone) row.phone = phone;
  const { error } = await db.from('verification_codes').upsert(row, { onConflict: email ? 'email,purpose' : 'phone,purpose' });
  if (error) throw new Error(error.message);
}

/** Fetch the pending code row for (email|phone, purpose), or null if none exists. */
export async function getCode({ email, phone, purpose }) {
  let q = db.from('verification_codes').select('*').eq('purpose', purpose);
  q = email ? q.eq('email', email.trim().toLowerCase()) : q.eq('phone', phone);
  const { data, error } = await q.maybeSingle();
  // A real DB error (e.g. the table is missing) must not look like "no code
  // found", that would silently turn into a wrong "invalid or expired code"
  // for every attempt instead of a loud, fixable failure.
  if (error) throw new Error(error.message);
  return data || null;
}

export async function deleteCode({ email, phone, purpose }) {
  let q = db.from('verification_codes').delete().eq('purpose', purpose);
  q = email ? q.eq('email', email.trim().toLowerCase()) : q.eq('phone', phone);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

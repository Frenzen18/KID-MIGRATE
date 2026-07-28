/** Philippine mobile number helpers shared by auth + user routes. */

export const PH_PHONE = /^\+639\d{9}$/;

/**
 * Normalizes a PH mobile number to canonical +639XXXXXXXXX form.
 * Accepts 09XXXXXXXXX, 639XXXXXXXXX, or +639XXXXXXXXX (spaces/dashes ok).
 * Returns null if the input is not a valid PH mobile number.
 */
export function normalizePhone(raw) {
  if (!raw) return null;
  let cleaned = String(raw).trim().replace(/[\s\-().]/g, '');
  if (/^09\d{9}$/.test(cleaned)) cleaned = '+63' + cleaned.slice(1);
  else if (/^639\d{9}$/.test(cleaned)) cleaned = '+' + cleaned;
  if (!PH_PHONE.test(cleaned)) return null;
  return cleaned;
}

// Supabase Auth's password sign-in is built around auth.users.email, there's
// no "email-less" account. A phone-only signup still needs a stable, unique
// value to put there, so it gets one derived deterministically from its own
// normalized number instead of a real address, the user never sees or types
// it (see profiles.phone_only, which marks that this email is a placeholder).
const SYNTHETIC_EMAIL_DOMAIN = 'phone.kidclinic.internal';

/** Deterministic placeholder email for a normalized +639XXXXXXXXX number. */
export function syntheticEmailForPhone(normalizedPhone) {
  return normalizedPhone.replace('+', '') + '@' + SYNTHETIC_EMAIL_DOMAIN;
}

/** True if `email` is one of the placeholder addresses this app generates for a phone-only account. */
export function isSyntheticEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith('@' + SYNTHETIC_EMAIL_DOMAIN);
}

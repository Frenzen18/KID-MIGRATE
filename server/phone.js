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

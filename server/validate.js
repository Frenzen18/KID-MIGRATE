/** Shared request-validation helpers (auth + user routes). */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Password policy: min 8 chars, at least 1 uppercase, 1 lowercase, 1 number,
 * and 1 special character. Mirrors the checklist shown in the UI, see
 * client/src/components/PasswordChecklist.jsx. Returns an error string or null.
 */
export function passwordPolicyError(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw)) return 'Password must contain at least 1 uppercase letter.';
  if (!/[a-z]/.test(pw)) return 'Password must contain at least 1 lowercase letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least 1 number.';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain at least 1 special character (e.g. ! @ # $ % ^ & *).';
  return null;
}

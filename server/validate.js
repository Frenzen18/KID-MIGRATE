/** Shared request-validation helpers (auth + user routes). */

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Password policy: min 8 chars, must contain letters and numbers. Returns an error string or null. */
export function passwordPolicyError(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain both letters and numbers.';
  return null;
}

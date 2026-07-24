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

/**
 * A person's name field: letters, spaces, hyphens, and apostrophes only, no
 * digits or other special characters, mirrors the client's live filter
 * (client/src/nameInput.js) as a server-side backstop for direct API calls.
 * Includes accented Latin letters (é, ñ, ...) common in Filipino/Spanish-
 * influenced names like "Peña" or "José".
 */
const NAME_RE = /^[A-Za-zÀ-ſ' -]+$/;

export function isValidName(str) {
  return typeof str === 'string' && NAME_RE.test(str.trim());
}

/**
 * A general free-text field (Allergies, Daily Medication, Development &
 * Functional Information, ...): letters, numbers, spaces, and common
 * punctuation only, mirrors the client's live filter
 * (client/src/textInput.js) as a server-side backstop for direct API calls.
 * Unlike isValidName, digits are allowed since these fields legitimately
 * need them (e.g. "500mg").
 */
const SAFE_TEXT_RE = /^[A-Za-z0-9À-ſ\s.,'()\-/:;]*$/;

export function isSafeText(str) {
  return typeof str === 'string' && SAFE_TEXT_RE.test(str.trim());
}

/**
 * Strips anything that isn't a letter, space, hyphen, or apostrophe, numbers
 * and other special characters aren't valid in a person's name (e.g. a stray
 * "3" or "@" pasted in by mistake). Includes accented Latin letters (é, ñ,
 * ...) common in Filipino/Spanish-influenced names like "Peña" or "José".
 */
export function filterNameInput(str) {
  return str.replace(/[^a-zA-ZÀ-ſ\s'-]/g, '').replace(/^\s+/, '');
}

/**
 * Capitalizes the first letter of every word live as the user types (e.g.
 * "juan dela cruz" -> "Juan Dela Cruz"), without touching letters typed
 * elsewhere in a word, so an intentionally mixed-case name like "McDonald"
 * stays exactly as typed past its first letter.
 */
export function capitalizeWords(str) {
  return str.replace(/(^|\s)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Combines filterNameInput + capitalizeWords, the standard live filter for a person-name field. */
export function sanitizeNameInput(str) {
  return capitalizeWords(filterNameInput(str));
}

/** True if `str` contains a digit or symbol filterNameInput() would strip, used to surface a live warning before it's silently removed. */
export function hasInvalidNameChars(str) {
  return /[^a-zA-ZÀ-ſ\s'-]/.test(str);
}

export const INVALID_NAME_MSG = 'Only letters, spaces, hyphens, and apostrophes are allowed.';

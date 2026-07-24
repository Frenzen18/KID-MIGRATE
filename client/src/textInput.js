/**
 * General free-text field filter (Allergies, Daily Medication, Development &
 * Functional Information, ...): letters, numbers, spaces, and common
 * punctuation (. , ' ( ) - / : ;) are allowed, since these fields legitimately
 * need digits (e.g. "500mg") unlike a strict name field, anything else (like
 * @ # $ % ^ & * < > { } [ ] | ~ ` = + _ " ! ?) is stripped as noise/injection
 * attempts rather than real clinical data.
 */
const UNSAFE_TEXT_RE = /[^a-zA-Z0-9À-ſ\s.,'()\-/:;]/g;

export function filterSafeTextInput(str) {
  return str.replace(UNSAFE_TEXT_RE, '').replace(/^\s+/, '');
}

/** True if `str` contains a character filterSafeTextInput() would strip, used to surface a live warning before it's silently removed. */
export function hasUnsafeTextChars(str) {
  return new RegExp(UNSAFE_TEXT_RE.source).test(str);
}

export const UNSAFE_TEXT_MSG = 'Special characters like @ # $ % ^ & * are not allowed.';

/** Calendar age in whole years from a "YYYY-MM-DD" (or ISO) date string, or null if invalid.
 *  Not a 365.25-day average, that rounds down near a birthday and could reject
 *  someone turning exactly the cutoff age (e.g. 18) today. */
export function calendarAge(dob) {
  const [y, m, d] = String(dob || '').slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const today = new Date();
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age;
}

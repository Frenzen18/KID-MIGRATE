/* == shared helpers for the reservations page + its modal components == */

export function pad(n) { return String(n).padStart(2, '0'); }
export function fmtYMD(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

/** Today's date string in Philippine time (UTC+8), independent of the browser's local timezone. */
export function todayPH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
export function nowPH() { return new Date(Date.now() + 8 * 60 * 60 * 1000); }

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const CAL_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* Time slots come from /reservations/slots, generated hourly from therapist
   shifts; each slot's capacity = therapists on shift at that hour. */
export const SESSION_MIN = 60; // a session runs 60 minutes, then the slot is "ended"

/** Session type is no longer hand-picked on the booking forms, it's derived
 *  from the child's assigned therapy program, same wording used elsewhere in the app. */
export function defaultSessionTypeFor(client) {
  const map = { OT: 'Occupational Therapy', Speech: 'Speech Therapy', Both: 'Combined' };
  return map[client?.therapy_type] || 'General Session';
}
/** Mirrors server/lib/billing.js rateFor(), used only to prefill the payment
 *  amount field on the booking/approval forms; staff can still edit it. */
export function rateForSessionType(sessionType) {
  const ot = /occupational|\bOT\b/i.test(sessionType || '');
  const sp = /speech/i.test(sessionType || '');
  if (ot && sp) return 2800;
  if (sp) return 1200;
  if (ot) return 1400;
  return 1400;
}
export function defaultRateFor(client) {
  return rateForSessionType(defaultSessionTypeFor(client));
}
export const STATUS_PILL = {
  pending: { label: 'Pending', cls: 'pill-amber' },
  confirmed: { label: 'Confirmed', cls: 'pill-green' },
  rescheduled: { label: 'Rescheduled', cls: 'pill-blue' },
  cancelled: { label: 'Cancelled', cls: 'pill-gray' },
  completed: { label: 'Completed', cls: 'pill-teal' },
  declined: { label: 'Declined', cls: 'pill-red' },
  no_show: { label: 'No-Show', cls: 'pill-red' }
};

export function slotMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((t || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}
export function toMinutes(t) { return slotMinutes(t); }

/* Compute selection metadata for a YYYY-MM-DD string */
export function computeSelection(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const cd = new Date(y, m - 1, d); cd.setHours(0, 0, 0, 0);
  const isPast = dateStr < todayPH();
  const label = DAY_NAMES[cd.getDay()] + ', ' + CAL_MONTH_NAMES[m - 1] + ' ' + d;
  return { date: dateStr, label, isPast, year: String(y) };
}

export function fmtShort(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return MON_SHORT[m - 1] + ' ' + d;
}

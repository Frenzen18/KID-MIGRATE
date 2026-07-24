/* == shared helpers for the reservations page + its modal components == */

export function pad(n) { return String(n).padStart(2, '0'); }
export function fmtYMD(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

/** Today's date string in Philippine time (UTC+8), independent of the browser's local timezone. */
export function todayPH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
export function nowPH() { return new Date(Date.now() + 8 * 60 * 60 * 1000); }

/** Earliest bookable date (tomorrow, PH time), bookings must be made at least
 *  a day ahead, same-day isn't allowed (see BOOKING_HOLD_MINUTES server-side). */
export function minBookableDatePH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

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
export const ASSESSMENT_TYPES = ['Initial Assessment', 'Speech-Language Assessment', 'Occupational Assessment'];

/** Assessment types that must go to a therapist of one specific discipline;
 *  booking requires picking that therapist before a day/time can be chosen. */
export const REQUIRED_ROLE_FOR_TYPE = { 'Speech-Language Assessment': 'speech', 'Occupational Assessment': 'ot' };

/** Which discipline a session type belongs to, null for discipline-agnostic
 *  types (e.g. Initial Assessment). Mirrors server/routes/reservations.js's
 *  own disciplineOfSessionType(), so a Combined client's regular "Occupational
 *  Therapy"/"Speech Therapy" sessions are recognized as the same discipline as
 *  an "Occupational Assessment"/"Speech-Language Assessment" booking. */
export function disciplineOfSessionType(type) {
  if (type === 'Occupational Therapy' || type === 'Occupational Assessment') return 'ot';
  if (type === 'Speech Therapy' || type === 'Speech-Language Assessment') return 'speech';
  return null;
}

/** "YYYY-MM-DD" → work_days index (Mon=0 … Sat=5, Sun=6). Mirrors server/routes/shifts.js. */
export function workDayIndex(dateStr) {
  return (new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7;
}
/** True if this therapist's shift covers the given date, same default
 *  (Mon–Sat) as the server when work_days hasn't been customized. */
export function therapistWorksOn(therapist, dateStr) {
  const wd = Array.isArray(therapist.work_days) && therapist.work_days.length === 7
    ? therapist.work_days
    : [true, true, true, true, true, true, false];
  return wd[workDayIndex(dateStr)] !== false;
}

/** Initial Assessment has no dedicated therapist picked ahead of time, so it's
 *  capped at one booking per hour clinic-wide. Speech-Language and Occupational
 *  Assessment instead require picking a specific therapist first (see
 *  REQUIRED_ROLE_FOR_TYPE), so their capacity is just that one therapist's own
 *  shift, letting every other qualified therapist still be booked the same hour,
 *  same as regular sessions, just never the same therapist twice. Returns how
 *  many more bookings the slot can take for the given service type. */
export function effectiveSlotAvailable(slot, serviceType) {
  if (!slot) return 0;
  if (slot.lunch_break) return 0;
  if (serviceType === 'Initial Assessment') {
    const alreadyBooked = (slot.reservations || []).some(r => r.session_type === 'Initial Assessment');
    return alreadyBooked ? 0 : 1;
  }
  return slot.available ?? 0;
}

export const STATUS_PILL = {
  awaiting_payment: { label: 'Pending', cls: 'pill-amber' },
  pending: { label: 'Pending', cls: 'pill-amber' },
  ongoing: { label: 'Ongoing', cls: 'pill-purple' },
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

/** True if `r` is a confirmed/rescheduled session whose own hour is happening
 *  right now (today, between its start time and start + its own duration_min,
 *  falling back to SESSION_MIN only if that column is somehow missing), not
 *  yet ended. Same "in progress" window the Book Client calendar's slotState()
 *  already uses, exposed here so the Adjust & Cancel table and the slot-actions
 *  modal can treat it as a real ("Ongoing") status too, not just a calendar
 *  badge. Uses the reservation's real duration instead of always assuming 60
 *  minutes, a longer (e.g. Combined OT+Speech) session must still show as
 *  ongoing past the hour mark instead of quietly "ending" on the dashboard
 *  while the actual session is still running. */
export function isOngoingReservation(r) {
  if (!r || !['confirmed', 'rescheduled'].includes(r.status)) return false;
  if (r.date !== todayPH()) return false;
  const mins = slotMinutes(r.time_slot);
  if (mins == null) return false;
  const now = nowPH();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const duration = r.duration_min || SESSION_MIN;
  return nowMin >= mins && nowMin < mins + duration;
}

/** A confirmed/rescheduled booking whose scheduled time has fully ended with
 *  nobody marking it Completed or No-Show. No-Show can only ever be marked
 *  while a session is Ongoing (see SlotActionsModal's canMarkNoShow), so once
 *  that window has closed without it, it's safe to treat the session as having
 *  happened normally, display/filter-only, this never writes the real status. */
export function isEffectivelyCompleted(r) {
  if (!r || !['confirmed', 'rescheduled'].includes(r.status)) return false;
  if (r.date < todayPH()) return true;
  if (r.date > todayPH()) return false;
  const mins = slotMinutes(r.time_slot);
  if (mins == null) return false;
  const now = nowPH();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const duration = r.duration_min || SESSION_MIN;
  return nowMin >= mins + duration;
}

/** Single source of truth for "what status does this row actually show as" —
 *  Ongoing and effectively-Completed both override the raw stored status for
 *  display, used identically by the status filter and the row's own pill so
 *  the two can never disagree (a row shown as Completed always also matches
 *  the Completed filter, and never still matches Confirmed/Rescheduled). */
export function effectiveStatusKey(r) {
  if (isOngoingReservation(r)) return 'ongoing';
  if (isEffectivelyCompleted(r)) return 'completed';
  return r?.status;
}

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

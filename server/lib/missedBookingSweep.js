import { db } from '../supabase.js';
import { notifyEvent } from './notify.js';
import { logAudit } from './audit.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The 3 most recent occurrences of `dayOfWeek` on or before today (most
 *  recent first), as "YYYY-MM-DD" strings. */
function last3PastOccurrences(dayOfWeek) {
  const today = new Date(todayPH() + 'T00:00:00Z');
  const diff = (today.getUTCDay() - dayOfWeek + 7) % 7;
  const cursor = new Date(today);
  cursor.setUTCDate(cursor.getUTCDate() - diff);
  const dates = [];
  for (let i = 0; i < 3; i++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  return dates;
}

/**
 * Companion to checkConsecutiveAbsences (noShow.js), which only ever catches
 * a family that booked and then no-showed/cancelled. It has nothing to react
 * to when a family just never books their fixed slot at all, no reservation
 * row means no event ever fires for it. This sweep instead checks, per
 * active recurring schedule, whether its 3 most recent already-past weekly
 * occurrences have literally zero reservation on file for any of them, not
 * "no-show", not "cancelled", nothing booked whatsoever.
 *
 * Treated the same as 3 consecutive UNEXCUSED absences (flag for staff
 * review, never an automatic fee or discharge): there's no guardian-supplied
 * reason to weigh, since nothing was ever booked for staff to mark excused
 * or not, so this can't be the "3 excused -> retainer fee" path, only the
 * "staff decides with context" one.
 */
export async function sweepMissedBookings() {
  try {
    const { data: schedules, error } = await db.from('recurring_schedules')
      .select('id, client_id, discipline, day_of_week, time_slot, therapist_name, status, created_at')
      .eq('status', 'active');
    if (error) { console.error('sweepMissedBookings: query failed:', error.message); return; }

    for (const schedule of schedules || []) {
      try {
        await checkSchedule(schedule);
      } catch (e) {
        console.error('sweepMissedBookings: per-schedule error for', schedule.id, ':', e.message);
      }
    }
  } catch (e) {
    console.error('sweepMissedBookings failed:', e.message);
  }
}

async function checkSchedule(schedule) {
  const occurrenceDates = last3PastOccurrences(schedule.day_of_week);
  const scheduleStartDate = schedule.created_at.slice(0, 10);
  // Only ever counts occurrences from after the schedule actually started, a
  // brand-new schedule doesn't get penalized for weeks before it existed.
  const eligibleDates = occurrenceDates.filter(d => d >= scheduleStartDate);
  if (eligibleDates.length < 3) return;

  const { data: existingRows } = await db.from('reservations')
    .select('date').eq('recurring_schedule_id', schedule.id).eq('is_makeup', false).in('date', eligibleDates);
  const bookedDates = new Set((existingRows || []).map(r => r.date));
  if (eligibleDates.some(d => bookedDates.has(d))) return; // at least one of the 3 weeks had *something* booked, streak's broken

  const latestMissedDate = eligibleDates[0];
  // Idempotent per how far the streak has advanced: fires again if a 4th,
  // 5th, etc. week passes still unbooked (still worth nudging staff), but
  // never repeats for the exact same 3-week streak on every sweep run.
  const flagKey = '3 consecutive weeks never booked';
  const { data: alreadyFlagged } = await db.from('audit_logs')
    .select('id').eq('table_name', 'recurring_schedules').eq('record_id', schedule.id)
    .ilike('description', `${flagKey} (through ${latestMissedDate})%`).maybeSingle();
  if (alreadyFlagged) return;

  const { data: client } = await db.from('clients').select('full_name, parent_id').eq('id', schedule.client_id).maybeSingle();
  const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const body = `${client?.full_name || 'A client'}'s ${sessionType} slot (${WEEKDAY_NAMES[schedule.day_of_week]}s at ${schedule.time_slot} with ${schedule.therapist_name}) hasn't been booked in 3 consecutive weeks (through ${latestMissedDate}). Per the MOA this slot is eligible for forfeiture, review it in Client Records and Discharge it if appropriate.`;
  await notifyEvent(null, { title: 'Slot never booked, 3 consecutive weeks', body, icon: 'fa-triangle-exclamation', target_role: 'admin' });
  await notifyEvent(null, { title: 'Slot never booked, 3 consecutive weeks', body, icon: 'fa-triangle-exclamation', target_role: 'staff' });
  await logAudit({
    table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
    description: `${flagKey} (through ${latestMissedDate}) for ${client?.full_name || 'client'}'s ${sessionType} schedule (${WEEKDAY_NAMES[schedule.day_of_week]}s at ${schedule.time_slot} with ${schedule.therapist_name})`
  });
}

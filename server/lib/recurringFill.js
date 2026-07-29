import { db } from '../supabase.js';
import { logAudit } from './audit.js';
import { isClinicHoliday, ensurePaymentForReservation } from '../routes/reservations.js';
import { getTherapistShifts, worksOn, isLunchHour, labelToHour } from '../routes/shifts.js';
import { FILL_HORIZON_DAYS } from './horizon.js';

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export { FILL_HORIZON_DAYS };

/**
 * Every date in [today+1, today+FILL_HORIZON_DAYS] that falls on `dayOfWeek`
 * (0=Sunday..6=Saturday, matching recurring_schedules.day_of_week and
 * JS Date#getUTCDay()). Starts at tomorrow, never today: today's occurrence
 * of the schedule's weekday may already have passed by the time this runs
 * (assignment could happen any time of day), and every other booking path in
 * this app already requires at least a day's notice - auto-fill shouldn't
 * silently create a same-day confirmed session nobody can act on in time.
 */
function upcomingWeekdayDates(dayOfWeek) {
  const dates = [];
  const start = new Date(todayPH() + 'T00:00:00Z');
  for (let i = 1; i <= FILL_HORIZON_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (d.getUTCDay() === dayOfWeek) dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Generates `confirmed` reservations for one active recurring schedule, for
 * every occurrence of its day/time within the rolling FILL_HORIZON_DAYS
 * window that doesn't already have a reservation on file. Skips a date that's
 * a clinic-wide holiday (set ahead of time, see isClinicHoliday) or one the
 * therapist no longer works (shift changed since the schedule was assigned) —
 * neither case creates a confirmed booking nobody can actually deliver.
 * Idempotent: safe to call repeatedly (assignment time, daily sweep), a date
 * that already has a live reservation is left untouched.
 */
export async function fillReservationsForSchedule(schedule, actorId) {
  if (schedule.status !== 'active') return { created: 0, skippedHolidays: 0 };

  const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const shifts = await getTherapistShifts();
  const shift = shifts.find(s => s.name === schedule.therapist_name);
  const hour = labelToHour(schedule.time_slot);

  const candidateDates = upcomingWeekdayDates(schedule.day_of_week);
  if (!candidateDates.length) return { created: 0, skippedHolidays: 0 };

  const { data: existing } = await db.from('reservations')
    .select('date').eq('recurring_schedule_id', schedule.id).in('date', candidateDates)
    .not('status', 'in', '(cancelled,declined)');
  const existingDates = new Set((existing || []).map(r => r.date));

  let created = 0;
  let skippedHolidays = 0;

  for (const date of candidateDates) {
    if (existingDates.has(date)) continue;
    if (await isClinicHoliday(date)) { skippedHolidays++; continue; }
    if (shift && (!worksOn(shift, date) || (hour != null && isLunchHour(shift, hour)))) continue;

    const { data: reservation, error } = await db.from('reservations').insert({
      client_id: schedule.client_id,
      therapist_name: schedule.therapist_name,
      date,
      time_slot: schedule.time_slot,
      session_type: sessionType,
      duration_min: 60,
      status: 'confirmed',
      channel: 'auto-fill',
      created_by: actorId,
      recurring_schedule_id: schedule.id,
      is_makeup: false
    }).select().single();
    if (error) {
      // A concurrent fill (assignment-time call racing the sweep) can lose the
      // unique-slot index race here, that date simply already exists now,
      // nothing to do.
      if (error.code === '23505') continue;
      console.error(`Auto-fill failed for schedule ${schedule.id} on ${date}:`, error.message);
      continue;
    }

    await ensurePaymentForReservation(reservation, actorId, {});
    created++;
  }

  if (created) {
    await logAudit({
      table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
      description: `Auto-filled ${created} confirmed ${sessionType} session(s) through ${candidateDates[candidateDates.length - 1]}`,
      created_by: actorId
    });
  }

  return { created, skippedHolidays };
}

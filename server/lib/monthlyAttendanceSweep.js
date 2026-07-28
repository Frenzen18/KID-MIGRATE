import { db } from '../supabase.js';
import { logAudit } from './audit.js';
import { notifyEvent } from './notify.js';

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** [start, end] (YYYY-MM-DD, inclusive) of the full calendar month immediately
 *  before whatever month `dateStr` falls in. */
function previousMonthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 2, 1));
  const end = new Date(Date.UTC(y, m - 1, 0)); // day 0 of this month = last day of previous month
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** How many times `dayOfWeek` (0=Sunday..6=Saturday) falls within [start, end], inclusive. */
function countWeekdayOccurrences(dayOfWeek, start, end) {
  let count = 0;
  const cursor = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');
  while (cursor <= endDate) {
    if (cursor.getUTCDay() === dayOfWeek) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/**
 * MOA monthly-attendance policy: a client is expected to attend at least 50%
 * of their scheduled sessions each month to retain their slot. This is
 * monitoring only, no automatic action, staff/admin decide whether to
 * discharge a chronically-under-attending slot by hand. Runs once per
 * calendar month per schedule (checks the just-completed previous month,
 * fully resolved by then), deduped via recurring_schedules.last_monthly_attendance_check.
 */
export async function sweepMonthlyAttendance() {
  try {
    const today = todayPH();
    const { start, end } = previousMonthRange(today);

    const { data: schedules, error } = await db.from('recurring_schedules')
      .select('id, client_id, discipline, day_of_week, time_slot, therapist_name, last_monthly_attendance_check, created_at')
      .eq('status', 'active')
      .or(`last_monthly_attendance_check.is.null,last_monthly_attendance_check.lt.${end}`);
    if (error) { console.error('sweepMonthlyAttendance: query failed:', error.message); return; }

    for (const schedule of schedules || []) {
      try {
        // A schedule created mid-month (or after the target month entirely)
        // wasn't around for the whole window, only count occurrences from
        // whichever is later: the month's own start, or the schedule's
        // creation date, otherwise a brand-new schedule gets falsely flagged
        // for "missing" sessions from before it even existed.
        const scheduleStart = schedule.created_at ? schedule.created_at.slice(0, 10) : start;
        const effectiveStart = scheduleStart > start ? scheduleStart : start;
        const expected = effectiveStart > end ? 0 : countWeekdayOccurrences(schedule.day_of_week, effectiveStart, end);
        if (expected === 0) { await db.from('recurring_schedules').update({ last_monthly_attendance_check: end }).eq('id', schedule.id); continue; }

        // Counts a raw 'completed' status, but also a 'confirmed'/'rescheduled'
        // one nobody ever explicitly resolved - this sweep only ever looks at
        // a fully-finished previous month, so any such row is guaranteed to
        // already be in the past, i.e. effectively completed, exactly like
        // the admin calendar's own display already treats it (isEffectivelyCompleted).
        // Without this, a schedule staff simply forgot to click "End Session"
        // on for a whole month would score a false 0% and trigger the
        // guardian-facing "below the minimum" email.
        // A make-up is an extra session outside the fixed weekly slot, not one
        // of its `expected` occurrences (see the same exclusion in
        // checkConsecutiveAbsences, noShow.js), counting it here could push
        // `actual` past `expected` for a client who's actually skipping their
        // regular slot but catching make-ups elsewhere.
        const { data: completed } = await db.from('reservations')
          .select('id').eq('recurring_schedule_id', schedule.id)
          .eq('is_makeup', false)
          .in('status', ['completed', 'confirmed', 'rescheduled'])
          .gte('date', start).lte('date', end);
        const actual = (completed || []).length;
        const rate = actual / expected;

        await db.from('recurring_schedules').update({ last_monthly_attendance_check: end }).eq('id', schedule.id);
        if (rate >= 0.5) continue;

        const { data: client } = await db.from('clients').select('full_name, parent_id').eq('id', schedule.client_id).maybeSingle();
        const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
        const pct = Math.round(rate * 100);
        const body = `${client?.full_name || 'A client'}'s ${sessionType} slot only attended ${actual} of ${expected} scheduled sessions last month (${pct}%), below the 50% minimum to retain the slot. Review and decide whether to keep or reassign it.`;

        await logAudit({
          table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
          description: `Monthly attendance ${pct}% (${actual}/${expected}) for ${start} to ${end}, below the 50% retention minimum`
        });
        if (client?.parent_id) {
          await notifyEvent(null, {
            title: 'Attendance below the minimum to keep your slot',
            body: `Your ${sessionType} slot attended ${actual} of ${expected} sessions last month (${pct}%). Regular attendance is required to keep your reserved slot, please contact the clinic.`,
            icon: 'fa-triangle-exclamation',
            target_user: client.parent_id
          });
        }
        await notifyEvent(null, { title: 'Client below 50% monthly attendance', body, icon: 'fa-triangle-exclamation', target_role: 'admin' });
        await notifyEvent(null, { title: 'Client below 50% monthly attendance', body, icon: 'fa-triangle-exclamation', target_role: 'staff' });
      } catch (rowErr) {
        console.error('sweepMonthlyAttendance: per-schedule error for', schedule.id, ':', rowErr.message);
      }
    }
  } catch (e) {
    console.error('sweepMonthlyAttendance failed:', e.message);
  }
}

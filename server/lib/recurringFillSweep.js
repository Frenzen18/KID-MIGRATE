import { db } from '../supabase.js';
import { fillReservationsForSchedule } from './recurringFill.js';

/**
 * Daily top-up: every active recurring_schedules row gets re-filled to the
 * rolling FILL_HORIZON_DAYS window (see recurringFill.js), since a day
 * passing means the horizon's far edge just moved forward by one day. Never
 * throws (same convention as every other sweep in this file), one schedule's
 * failure doesn't block the rest.
 */
export async function sweepRecurringFill() {
  try {
    const { data: schedules, error } = await db.from('recurring_schedules').select('*').eq('status', 'active');
    if (error) { console.error('sweepRecurringFill: failed to load schedules:', error.message); return; }
    for (const schedule of schedules || []) {
      try {
        await fillReservationsForSchedule(schedule, schedule.created_by || null);
      } catch (e) {
        console.error(`sweepRecurringFill: schedule ${schedule.id} failed:`, e.message);
      }
    }
  } catch (e) {
    console.error('sweepRecurringFill failed:', e.message);
  }
}

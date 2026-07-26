import { db } from '../supabase.js';
import { logAudit } from './audit.js';
import { notifyEvent } from './notify.js';
import { applyNoShowSideEffects } from './noShow.js';

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * A session's own payment is due by 11:59 PM of its own date, same rule for
 * every confirmed/rescheduled session, staff-booked or schedule-generated
 * alike. Once that date has fully passed (it's now tomorrow or later, PH
 * time) with the session invoice still unpaid, it's auto-marked no_show,
 * same real effect (attendance record + no-show fee) as if staff had marked
 * it by hand. Never touches a session whose own date is still today, only
 * once the day has actually ended.
 *
 * Excludes sessions tied to a recurring schedule (recurring_schedule_id set):
 * those are confirmed the instant they're booked with payment tracked
 * completely separately (guardian may pay online, or in person after the
 * fact), so an unpaid invoice there says nothing about whether the child
 * actually showed up. Attendance on those is staff's own call (see
 * applyNoShowSideEffects via PUT /reservations/:id), never inferred from
 * payment status, otherwise a family that simply hasn't paid yet gets
 * wrongly no-showed, fee'd, and eventually forfeits the slot for sessions
 * they actually attended.
 */
export async function sweepUnpaidPastSessions() {
  try {
    const today = todayPH();
    const { data: unpaidFees, error: payErr } = await db.from('payments')
      .select('reservation_id')
      .eq('fee_type', 'session').in('status', ['pending', 'overdue'])
      .not('reservation_id', 'is', null);
    if (payErr) { console.error('sweepUnpaidPastSessions: payments query failed:', payErr.message); return; }

    const unpaidReservationIds = [...new Set((unpaidFees || []).map(p => p.reservation_id))];
    if (!unpaidReservationIds.length) return;

    const { data: candidates, error } = await db.from('reservations')
      .select('*')
      .in('id', unpaidReservationIds)
      .in('status', ['confirmed', 'rescheduled'])
      .lt('date', today)
      .is('recurring_schedule_id', null);
    if (error) { console.error('sweepUnpaidPastSessions: reservations query failed:', error.message); return; }

    for (const r of candidates || []) {
      try {
        await db.from('reservations').update({
          status: 'no_show',
          notes: (r.notes ? r.notes + ' · ' : '') + 'Auto-marked no-show, session payment was not received by end of session day'
        }).eq('id', r.id);

        await applyNoShowSideEffects(r);

        await logAudit({
          table_name: 'reservations', record_id: r.id, action: 'update',
          description: `Auto-marked no-show, unpaid past session date (${r.date} ${r.time_slot})`
        });

        if (r.created_by) {
          await notifyEvent(null, {
            title: 'Session marked as no-show',
            body: `Your session on ${r.date} at ${r.time_slot} was marked as a no-show because payment wasn't received by the end of that day.`,
            icon: 'fa-calendar-xmark',
            target_user: r.created_by
          });
        }
      } catch (rowErr) {
        console.error('sweepUnpaidPastSessions: per-row error for reservation', r.id, ':', rowErr.message);
      }
    }
  } catch (e) {
    console.error('sweepUnpaidPastSessions failed:', e.message);
  }
}

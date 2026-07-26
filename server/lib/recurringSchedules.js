import { db } from '../supabase.js';
import { logAudit } from './audit.js';
import { notifyEvent } from './notify.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Ends a client's fixed weekly schedule for a discipline and notifies whoever
 * is next on the waitlist for that exact day/time/therapist, shared by the
 * staff-initiated PUT /recurring-schedules/:id route and the automatic
 * 3-consecutive-unexcused-absence forfeiture path (see checkConsecutiveAbsences
 * in noShow.js). `reason` distinguishes the two in the audit trail and the
 * guardian-facing notification wording.
 */
export async function dischargeSchedule(schedule, actorId, { reason = 'manual' } = {}) {
  const { data, error } = await db.from('recurring_schedules').update({ status: 'discharged' }).eq('id', schedule.id).select().single();
  if (error) throw new Error(error.message);

  const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  await logAudit({
    table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
    description: reason === 'forfeiture'
      ? `${sessionType} schedule forfeited, 3 consecutive unexcused absences`
      : `${schedule.discipline} therapy schedule discharged`,
    updated_by: actorId || null
  });

  const { data: nextInLine } = await db.from('schedule_waitlist')
    .select('id, client_id, clients(full_name, parent_id)')
    .eq('day_of_week', schedule.day_of_week).eq('time_slot', schedule.time_slot).eq('therapist_name', schedule.therapist_name)
    .eq('status', 'waiting').order('created_at', { ascending: true }).limit(1).maybeSingle();
  let notifiedWaitlistClient = null;
  if (nextInLine) {
    notifiedWaitlistClient = nextInLine.clients?.full_name || null;
    await db.from('schedule_waitlist').update({ status: 'notified' }).eq('id', nextInLine.id);
    await logAudit({
      table_name: 'schedule_waitlist', record_id: nextInLine.id, action: 'update',
      description: `Notified: ${notifiedWaitlistClient || 'client'} is next in line for ${WEEKDAY_NAMES[schedule.day_of_week]} ${schedule.time_slot} with ${schedule.therapist_name}`
    });
    if (nextInLine.clients?.parent_id) {
      await notifyEvent(null, {
        title: 'A therapy slot opened up',
        body: `${notifiedWaitlistClient}'s waitlisted ${sessionType} slot (${WEEKDAY_NAMES[schedule.day_of_week]}s at ${schedule.time_slot} with ${schedule.therapist_name}) is now available. Please contact the clinic to confirm.`,
        icon: 'fa-calendar-check',
        target_user: nextInLine.clients.parent_id
      });
    }
    await notifyEvent(null, {
      title: 'Waitlisted slot ready to assign',
      body: `${notifiedWaitlistClient || 'A client'} is next in line for ${WEEKDAY_NAMES[schedule.day_of_week]} ${schedule.time_slot} with ${schedule.therapist_name}, now that it's open.`,
      icon: 'fa-calendar-check',
      target_role: 'staff'
    });
  }

  return { schedule: data, notifiedWaitlistClient };
}

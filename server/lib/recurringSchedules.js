import { db } from '../supabase.js';
import { logAudit } from './audit.js';
import { notifyEvent, channelEnabled } from './notify.js';
import { sendMail } from '../mailer.js';
import { sendSms } from '../sms.js';
import { releaseSessionPaymentAsCredit } from './noShow.js';

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Sends the actual SMS/email/in-app offer for one waitlist entry and flips it
 * to 'notified', shared by the automatic FIFO pick (notifyWaitlistForFreedSlot)
 * and staff manually notifying a specific entry out of order (POST
 * /schedule-waitlist/:id/notify in reservations.js). `entry` must carry
 * discipline/day_of_week/time_slot/therapist_name plus a joined
 * clients(full_name, parent_id, guardian_contact).
 */
export async function notifyWaitlistEntry(entry) {
  const sessionType = entry.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const notifiedWaitlistClient = entry.clients?.full_name || null;
  await db.from('schedule_waitlist').update({ status: 'notified' }).eq('id', entry.id);
  await logAudit({
    table_name: 'schedule_waitlist', record_id: entry.id, action: 'update',
    description: `Notified: ${notifiedWaitlistClient || 'client'} is next in line for ${WEEKDAY_NAMES[entry.day_of_week]} ${entry.time_slot} with ${entry.therapist_name}`
  });

  const slotDesc = `${WEEKDAY_NAMES[entry.day_of_week]}s at ${entry.time_slot} with ${entry.therapist_name}`;
  if (entry.clients?.parent_id) {
    await notifyEvent(null, {
      title: 'A therapy slot opened up',
      body: `${notifiedWaitlistClient}'s waitlisted ${sessionType} slot (${slotDesc}) is now available. Accept or decline it from your Booking page.`,
      icon: 'fa-calendar-check',
      target_user: entry.clients.parent_id
    });

    const { data: guardian } = await db.from('profiles').select('email, full_name').eq('id', entry.clients.parent_id).maybeSingle();
    if (guardian?.email && await channelEnabled('channel_email')) {
      sendMail({
        to: guardian.email,
        subject: `A therapy slot is available: ${notifiedWaitlistClient}`,
        html: `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
              <p style="color: #64748B; font-size: 13px;">Pediatric Speech &amp; Occupational Therapy</p>
            </div>
            <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px;">
              <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${guardian.full_name || 'there'},</p>
              <p style="color: #64748B; font-size: 13px; margin: 0 0 16px; line-height: 1.7;">
                A ${sessionType} slot ${notifiedWaitlistClient} was waitlisted for is now open: <strong>${slotDesc}</strong>.
              </p>
              <p style="color: #64748B; font-size: 13px; margin: 0; line-height: 1.7;">
                Please log in to your Guardian Portal and go to the Booking page to accept or decline it. It's offered first-come, first-served among the waitlist, so it may go to someone else if left too long.
              </p>
            </div>
          </div>
        `
      }).catch(e => console.error('Waitlist offer email failed:', e.message));
    }
    if (entry.clients?.guardian_contact && await channelEnabled('channel_sms')) {
      sendSms({
        to: entry.clients.guardian_contact,
        message: `KID Clinic: A ${sessionType} slot ${notifiedWaitlistClient} was waitlisted for is now open (${slotDesc}). Log in to your Guardian Portal's Booking page to accept or decline it.`
      }).catch(e => console.error('Waitlist offer SMS failed:', e.message));
    }
  }
  await notifyEvent(null, {
    title: 'Waitlisted slot ready to assign',
    body: `${notifiedWaitlistClient || 'A client'} is next in line for ${WEEKDAY_NAMES[entry.day_of_week]} ${entry.time_slot} with ${entry.therapist_name}, now that it's open.`,
    icon: 'fa-calendar-check',
    target_role: 'staff'
  });
  return notifiedWaitlistClient;
}

/**
 * Notifies whoever is next on the waitlist for an exact day/time/therapist
 * combo that just freed up, either because a schedule was discharged, editing
 * one moved it off that slot, or the guardian who was just offered it
 * declined/it fell through (see dischargeSchedule, PUT /recurring-schedules/:id's
 * edit path, and POST /schedule-waitlist/:id/accept|decline in reservations.js).
 * Shared so every path behaves identically: same FIFO pick, same audit trail,
 * same in-app notification, plus SMS and email so the guardian actually finds
 * out to accept or decline it, rather than only ever seeing it if they happen
 * to open the portal.
 */
export async function notifyWaitlistForFreedSlot(discipline, day_of_week, time_slot, therapist_name) {
  const { data: nextInLine } = await db.from('schedule_waitlist')
    .select('id, client_id, clients(full_name, parent_id, guardian_contact)')
    .eq('day_of_week', day_of_week).eq('time_slot', time_slot).eq('therapist_name', therapist_name)
    .eq('status', 'waiting').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!nextInLine) return null;
  return notifyWaitlistEntry({ ...nextInLine, discipline, day_of_week, time_slot, therapist_name });
}

/**
 * Directly assigns a waitlisted client to their slot without the notify/accept
 * round-trip, for staff manually clicking Assign on the Waitlist tab (e.g. once
 * the outgoing client has already been discharged and there's no reason to wait
 * on a guardian response). Re-checks the slot is genuinely free and the client
 * doesn't already collide with it, same guards as the guardian-initiated
 * POST /schedule-waitlist/:id/accept. Throws on any conflict; caller reports it.
 */
export async function assignWaitlistEntry(entry, actorId) {
  const client = entry.clients;
  const sessionType = entry.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';

  const { data: alreadyHasTherapist } = await db.from('recurring_schedules')
    .select('id').eq('client_id', client.id).eq('therapist_name', entry.therapist_name).eq('status', 'active').maybeSingle();
  if (alreadyHasTherapist) throw new Error(`${entry.therapist_name} already has an active schedule with ${client.full_name}, one session per therapist per week.`);

  const { data: clientSameSlot } = await db.from('recurring_schedules')
    .select('id').eq('client_id', client.id).eq('day_of_week', entry.day_of_week).eq('time_slot', entry.time_slot).eq('status', 'active').maybeSingle();
  if (clientSameSlot) throw new Error(`${client.full_name} already has a schedule at that day and time.`);

  const { data: slotTakenBy } = await db.from('recurring_schedules')
    .select('id').eq('day_of_week', entry.day_of_week).eq('time_slot', entry.time_slot).eq('therapist_name', entry.therapist_name).eq('status', 'active').maybeSingle();
  if (slotTakenBy) throw new Error('That slot is already taken by another client.');

  const { data: schedule, error: schedErr } = await db.from('recurring_schedules').insert({
    client_id: client.id, discipline: entry.discipline, day_of_week: entry.day_of_week, time_slot: entry.time_slot, therapist_name: entry.therapist_name,
    status: 'active', created_by: actorId
  }).select().single();
  if (schedErr) throw new Error(schedErr.message);

  const clientPatch = {};
  if (entry.discipline === 'OT') clientPatch.assigned_ot_therapist_name = entry.therapist_name;
  else clientPatch.assigned_speech_therapist_name = entry.therapist_name;
  if (!client.therapy_type) clientPatch.therapy_type = entry.discipline;
  else if (client.therapy_type !== entry.discipline && client.therapy_type !== 'Both') clientPatch.therapy_type = 'Both';
  await db.from('clients').update(clientPatch).eq('id', client.id);

  await db.from('schedule_waitlist').update({ status: 'accepted' }).eq('id', entry.id);

  return { schedule, sessionType };
}

/**
 * Cancels every still-future reservation tied to a schedule that's about to
 * be discharged. Discharging ends the family's claim to the slot, leaving
 * their already-booked future occurrences standing would strand them on a
 * schedule that no longer exists (can't be rescheduled or self-cancelled,
 * see the "no longer active" guards in PUT /reservations/:id) AND keep the
 * slot occupied right when the waitlist is about to be offered it. Treated
 * like a legitimate-reason cancellation: a paid invoice becomes a credit for
 * the family's next session, a pending one is simply dropped, no fee either way.
 */
async function cancelFutureReservationsForDischarge(schedule) {
  const { data: future } = await db.from('reservations')
    .select('*').eq('recurring_schedule_id', schedule.id)
    .in('status', ['confirmed', 'rescheduled', 'awaiting_payment'])
    .gt('date', todayPH());
  for (const r of future || []) {
    await db.from('payments').delete().eq('reservation_id', r.id).eq('status', 'pending');
    const credited = await releaseSessionPaymentAsCredit(r, 'Schedule discharged');
    await db.from('reservations').update({ status: 'cancelled', no_show_excused: true }).eq('id', r.id);
    if (r.created_by) {
      await notifyEvent(null, {
        title: 'Session cancelled, schedule ended',
        body: `Your session on ${r.date} at ${r.time_slot} was cancelled because that fixed schedule has ended.${credited ? ' Your payment for it will be applied to your next session.' : ''}`,
        icon: 'fa-circle-check',
        target_user: r.created_by
      });
    }
  }
  return (future || []).length;
}

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

  // Clear the slot for real BEFORE telling the waitlist it's open, otherwise
  // the next family accepts it while the outgoing client's future sessions
  // are still sitting on the calendar, colliding with every one of theirs.
  const cancelledCount = await cancelFutureReservationsForDischarge(schedule);

  const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  await logAudit({
    table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
    description: (reason === 'forfeiture'
      ? `${sessionType} schedule forfeited, 3 consecutive unexcused absences`
      : `${schedule.discipline} therapy schedule discharged`) + (cancelledCount ? `, ${cancelledCount} future session(s) cancelled` : ''),
    updated_by: actorId || null
  });

  const notifiedWaitlistClient = await notifyWaitlistForFreedSlot(schedule.discipline, schedule.day_of_week, schedule.time_slot, schedule.therapist_name);

  return { schedule: data, notifiedWaitlistClient, cancelledCount };
}

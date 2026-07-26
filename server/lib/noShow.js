import { db } from '../supabase.js';
import { genInvoiceNo, NO_SHOW_FEE, retainerFeeFor } from './billing.js';
import { notifyEvent } from './notify.js';
import { logAudit } from './audit.js';
import { dischargeSchedule } from './recurringSchedules.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Detaches a reservation's already-paid session invoice into a floating
 * credit (reservation_id -> null, stays status 'paid'), so it doesn't just
 * strand on a reservation that's no longer happening. ensurePaymentForReservation
 * auto-applies the oldest available credit to whichever session the client
 * books next, before ever creating a fresh invoice. Used for both an excused
 * no-show and a legitimate-reason cancellation, same real situation either way:
 * the guardian already paid for a session that isn't going to happen.
 */
export async function releaseSessionPaymentAsCredit(reservation, contextNote) {
  const { data: paidInvoice } = await db.from('payments').select('*')
    .eq('reservation_id', reservation.id).eq('fee_type', 'session').eq('status', 'paid').maybeSingle();
  if (!paidInvoice) return null;
  await db.from('payments').update({ reservation_id: null }).eq('id', paidInvoice.id);
  await logAudit({
    table_name: 'payments', record_id: paidInvoice.id, action: 'update',
    description: `${contextNote}, payment for ${reservation.date} ${reservation.time_slot} (${paidInvoice.invoice_no}) held as a credit for the next session`
  });
  return paidInvoice;
}

/**
 * MOA slot-retainment policy: looks at a recurring schedule's last 3 resolved
 * outcomes (completed/no_show/cancelled, most recent first). If a session in
 * there was actually attended, the streak's broken, nothing happens. If all 3
 * were absences (no-show or cancelled) and all excused, a one-time 50%
 * retainer fee is charged to keep the slot. If all 3 were absences and all
 * UNEXCUSED, the slot is forfeited outright (auto-discharged, same as a
 * manual staff discharge, including notifying the next waitlisted client).
 * Called after every no-show/cancellation on a schedule, a no-op for a
 * one-off (non-scheduled) reservation.
 */
export async function checkConsecutiveAbsences(reservation, actorId) {
  if (!reservation.recurring_schedule_id) return;

  const { data: recent } = await db.from('reservations')
    .select('id, status, no_show_excused, date, time_slot')
    .eq('recurring_schedule_id', reservation.recurring_schedule_id)
    .in('status', ['completed', 'no_show', 'cancelled'])
    .order('date', { ascending: false })
    .limit(3);
  if (!recent || recent.length < 3) return;

  const absences = recent.filter(r => r.status === 'no_show' || r.status === 'cancelled');
  if (absences.length !== 3) return; // a completed session anywhere in the last 3 breaks the streak

  const { data: schedule } = await db.from('recurring_schedules')
    .select('id, client_id, discipline, day_of_week, time_slot, therapist_name, status')
    .eq('id', reservation.recurring_schedule_id).maybeSingle();
  if (!schedule || schedule.status !== 'active') return; // already discharged, nothing left to protect

  const { data: client } = await db.from('clients').select('full_name, parent_id').eq('id', schedule.client_id).maybeSingle();
  const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const latest = absences[0]; // the 3rd, most recent absence, where the fee/forfeiture attaches

  if (absences.every(r => r.no_show_excused === true)) {
    // 3 consecutive EXCUSED absences: retain the slot, but charge the MOA's
    // 50%-of-rate retainer fee. Idempotent via the (reservation_id, fee_type)
    // unique index, calling this again for the same 3rd absence never double-charges.
    const { data: existingRetainer } = await db.from('payments').select('id')
      .eq('reservation_id', latest.id).eq('fee_type', 'retainer_fee').maybeSingle();
    if (existingRetainer) return;

    const amount = retainerFeeFor(sessionType);
    const invoice_no = await genInvoiceNo();
    const { error } = await db.from('payments').insert({
      client_id: schedule.client_id, reservation_id: latest.id, fee_type: 'retainer_fee',
      amount, method: 'Unpaid', status: 'pending', invoice_no
    });
    if (error) { console.error('Retainer fee creation failed:', error.message); return; }

    await logAudit({
      table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
      description: `Retainer fee (₱${amount}) charged, 3 consecutive excused absences for ${client?.full_name || 'client'}'s ${sessionType} schedule`
    });
    const body = `${client?.full_name || 'A client'}'s ${sessionType} slot (${latest.date} onward) has had 3 consecutive excused absences. A ₱${amount} retainer fee was charged to keep the slot.`;
    if (client?.parent_id) await notifyEvent(null, { title: 'Retainer fee charged to keep your slot', body, icon: 'fa-triangle-exclamation', target_user: client.parent_id });
    await notifyEvent(null, { title: 'Retainer fee charged', body, icon: 'fa-triangle-exclamation', target_role: 'admin' });
    await notifyEvent(null, { title: 'Retainer fee charged', body, icon: 'fa-triangle-exclamation', target_role: 'staff' });
  } else if (absences.every(r => r.no_show_excused === false)) {
    // 3 consecutive UNEXCUSED absences: the MOA forfeits the slot outright,
    // it may be reassigned to whoever's next on that slot's waitlist.
    const { notifiedWaitlistClient } = await dischargeSchedule(schedule, actorId, { reason: 'forfeiture' });
    const body = `${client?.full_name || 'A client'}'s ${sessionType} slot (${WEEKDAY_NAMES[schedule.day_of_week]}s at ${schedule.time_slot} with ${schedule.therapist_name}) was forfeited after 3 consecutive unexcused absences.${notifiedWaitlistClient ? ` ${notifiedWaitlistClient} was notified from the waitlist.` : ''}`;
    if (client?.parent_id) await notifyEvent(null, { title: 'Therapy slot forfeited', body, icon: 'fa-calendar-xmark', target_user: client.parent_id });
    await notifyEvent(null, { title: 'Slot forfeited (3 consecutive unexcused absences)', body, icon: 'fa-calendar-xmark', target_role: 'admin' });
    await notifyEvent(null, { title: 'Slot forfeited (3 consecutive unexcused absences)', body, icon: 'fa-calendar-xmark', target_role: 'staff' });
  }
  // A mixed streak (some excused, some not) isn't 3-of-a-kind, no action either way.
}

/**
 * The side effects of a reservation actually becoming a no-show, shared by
 * both a staff/admin manually marking one (PUT /api/reservations/:id) and the
 * automatic sweep for a session whose payment never came in by end of its own
 * day (see sweepUnpaidPastSessions, always unexcused). Doesn't touch
 * reservation.status itself, callers update that (and log their own,
 * differently-worded audit entry) before calling this.
 *
 * `excused` (staff's own judgment call, e.g. a documented illness) skips the
 * no-show fee entirely and releases any already-paid invoice as a credit. An
 * unexcused no-show behaves exactly as before, a flat no-show fee added.
 * Either way, persists the outcome and checks the 3-consecutive-absence
 * slot-retainment policy for the schedule it belongs to (see above).
 */
export async function applyNoShowSideEffects(reservation, { excused = false, actorId } = {}) {
  // Keep attendance-rate reporting (parent portal, admin reports) in sync
  // with the booking outcome, same table/shape as POST /clients/:id/attendance.
  await db.from('attendance').insert({ client_id: reservation.client_id, session_date: reservation.date, attended: false });
  await db.from('reservations').update({ no_show_excused: excused }).eq('id', reservation.id);

  if (excused) {
    const credited = await releaseSessionPaymentAsCredit(reservation, 'Excused absence');
    if (reservation.created_by) {
      await notifyEvent(null, {
        title: 'Session excused',
        body: `Your session on ${reservation.date} at ${reservation.time_slot} was excused, no fee was charged.${credited ? ' Your payment for it will be applied to your next session.' : ''}`,
        icon: 'fa-circle-check',
        target_user: reservation.created_by
      });
    }
  } else {
    // Per the clinic's MOA no-show policy: a missed session adds a separate
    // penalty charge on top of (never replacing) the session's own invoice,
    // the guardian must actively pay it, nothing is auto-charged to a card.
    // Idempotent via the (reservation_id, fee_type) unique index, so calling
    // this twice for the same reservation never creates a second fee.
    const { data: existingFee } = await db.from('payments').select('id')
      .eq('reservation_id', reservation.id).eq('fee_type', 'no_show_fee').maybeSingle();
    if (!existingFee) {
      const invoice_no = await genInvoiceNo();
      const { error: feeErr } = await db.from('payments').insert({
        client_id: reservation.client_id, reservation_id: reservation.id, fee_type: 'no_show_fee',
        amount: NO_SHOW_FEE, method: 'Unpaid', status: 'pending', invoice_no
      });
      if (!feeErr && reservation.created_by) {
        await notifyEvent(null, {
          title: 'No-show fee added',
          body: `A ₱${NO_SHOW_FEE} no-show fee was added for the missed session on ${reservation.date} at ${reservation.time_slot}.`,
          icon: 'fa-triangle-exclamation',
          target_user: reservation.created_by
        });
      }
    }
  }

  await checkConsecutiveAbsences({ ...reservation, no_show_excused: excused }, actorId);
}

/**
 * Side effects of cancelling a reservation for a legitimate reason (staff
 * cancelling a confirmed, already-scheduled session on the guardian's behalf,
 * e.g. they called in sick): releases any already-paid invoice as a credit,
 * and counts as an excused absence for the slot-retainment policy above.
 * A cancellation is always treated as excused, that's the whole premise of
 * "legitimate reason", an unexcused no-show is a different status entirely.
 */
export async function applyCancelSideEffects(reservation, actorId) {
  await db.from('reservations').update({ no_show_excused: true }).eq('id', reservation.id);
  const credited = await releaseSessionPaymentAsCredit(reservation, 'Cancelled for a legitimate reason');
  if (reservation.created_by && credited) {
    await notifyEvent(null, {
      title: 'Session cancelled, payment held as credit',
      body: `Your session on ${reservation.date} at ${reservation.time_slot} was cancelled. Your payment for it will be applied to your next session.`,
      icon: 'fa-circle-check',
      target_user: reservation.created_by
    });
  }

  // A real, previously-confirmed therapy slot just opened back up, staff/admin
  // get flagged so they can offer it as a make-up session to a client who
  // needs one (e.g. from a recent excused absence), rather than it just
  // quietly sitting open until someone happens to notice on the calendar.
  if (reservation.session_type === 'Occupational Therapy' || reservation.session_type === 'Speech Therapy') {
    const { data: client } = await db.from('clients').select('full_name').eq('id', reservation.client_id).maybeSingle();
    const body = `${reservation.session_type} on ${reservation.date} at ${reservation.time_slot}${reservation.therapist_name ? ' with ' + reservation.therapist_name : ''} just opened up (${client?.full_name || 'a client'}'s cancellation), free to offer as a make-up session.`;
    await notifyEvent(null, { title: 'Slot open for a make-up session', body, icon: 'fa-calendar-check', target_role: 'admin' });
    await notifyEvent(null, { title: 'Slot open for a make-up session', body, icon: 'fa-calendar-check', target_role: 'staff' });
  }

  await checkConsecutiveAbsences({ ...reservation, no_show_excused: true }, actorId);
}

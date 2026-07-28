import { db } from '../supabase.js';
import { genInvoiceNo, NO_SHOW_FEE, retainerFeeFor } from './billing.js';
import { notifyEvent } from './notify.js';
import { logAudit } from './audit.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** End of the current PH-time calendar week (Sunday, inclusive), as a
 *  "YYYY-MM-DD" string. Used to keep the 3-consecutive-absence check from
 *  counting a session that was cancelled far ahead of time, see
 *  checkConsecutiveAbsences below. */
function currentWeekEndPH() {
  const d = new Date(todayPH() + 'T00:00:00Z');
  const daysUntilSunday = 6 - ((d.getUTCDay() + 6) % 7);
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  return d.toISOString().slice(0, 10);
}

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
 * UNEXCUSED, the slot is only flagged for staff review (notified, logged),
 * NOT auto-discharged - staff decide with real-world context whether to
 * actually Discharge it by hand from Client Records, leaving room to give a
 * family leeway instead of an automatic system decision making that call for
 * them. Called after every no-show/cancellation on a schedule, a no-op for a
 * one-off (non-scheduled) reservation.
 *
 * Only counts a session dated this week or earlier - cancelling a session
 * that's still weeks away hasn't actually been missed yet, it's just advance
 * notice, and shouldn't spend one of the family's 3 strikes before the
 * session was ever due. Once that week actually arrives, the next event on
 * this schedule re-runs this same query and picks it up naturally.
 */
export async function checkConsecutiveAbsences(reservation) {
  if (!reservation.recurring_schedule_id) return;

  // Only the schedule's OWN regular weekly occurrences count toward "3
  // consecutive" - never a make-up (deliberately booked on a different day,
  // see POST /reservations), which would otherwise mix into the same
  // recurring_schedule_id and get mistaken for one of the schedule's real
  // weekly misses.
  const { data: rows } = await db.from('reservations')
    .select('id, status, no_show_excused, date, time_slot')
    .eq('recurring_schedule_id', reservation.recurring_schedule_id)
    .eq('is_makeup', false)
    .in('status', ['completed', 'no_show', 'cancelled', 'confirmed', 'rescheduled'])
    .lte('date', currentWeekEndPH())
    .order('date', { ascending: false })
    .limit(3);
  if (!rows || rows.length < 3) return;

  // Must be 3 genuinely CONSECUTIVE weekly occurrences of this exact
  // schedule, not just "the last 3 rows on file" for it - a week the family
  // never booked at all leaves no row whatsoever, and silently skipping past
  // that gap to reach further back in history would let two separate,
  // non-consecutive incidents (weeks or months apart) masquerade as one real
  // 3-in-a-row streak.
  for (let i = 0; i < rows.length - 1; i++) {
    const gapDays = Math.round((Date.parse(rows[i].date) - Date.parse(rows[i + 1].date)) / 86400000);
    if (gapDays !== 7) return;
  }

  // Any row that isn't itself an absence - completed, or still
  // confirmed/rescheduled (whether that's a genuine future booking or one
  // nobody ever explicitly resolved, effectively completed just like
  // everywhere else in the app treats it) - breaks the streak.
  const recent = rows;
  const absences = recent.filter(r => r.status === 'no_show' || r.status === 'cancelled');
  if (absences.length !== 3) return;

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
    // 3 consecutive UNEXCUSED absences: flag it for staff review instead of
    // auto-forfeiting the slot outright, an automatic system decision leaves
    // no room for staff to give a family leeway (and makes waiving a related
    // fee pointless, the slot's already gone by then). Staff decide with
    // real-world context whether to actually Discharge it (already possible
    // from Client Records), this just makes sure they can't miss that the
    // threshold was hit. Keyed off `latest.id` (idempotent per audit_logs, no
    // schema change needed) so it fires once per newly-completed streak, but
    // fires again for a 4th/5th etc. unresolved absence, still nudging staff.
    const flagKey = '3 consecutive unexcused absences flagged';
    const { data: alreadyFlagged } = await db.from('audit_logs')
      .select('id').eq('table_name', 'reservations').eq('record_id', latest.id).ilike('description', `${flagKey}%`).maybeSingle();
    if (!alreadyFlagged) {
      const body = `${client?.full_name || 'A client'}'s ${sessionType} slot (${WEEKDAY_NAMES[schedule.day_of_week]}s at ${schedule.time_slot} with ${schedule.therapist_name}) has reached 3 consecutive unexcused absences. Per the MOA this slot is eligible for forfeiture, review it in Client Records and Discharge it if appropriate.`;
      await notifyEvent(null, { title: 'Slot eligible for forfeiture (3 consecutive unexcused)', body, icon: 'fa-triangle-exclamation', target_role: 'admin' });
      await notifyEvent(null, { title: 'Slot eligible for forfeiture (3 consecutive unexcused)', body, icon: 'fa-triangle-exclamation', target_role: 'staff' });
      await logAudit({
        table_name: 'reservations', record_id: latest.id, action: 'update',
        description: `${flagKey} for ${client?.full_name || 'client'}'s ${sessionType} schedule (${WEEKDAY_NAMES[schedule.day_of_week]}s at ${schedule.time_slot} with ${schedule.therapist_name})`
      });
    }
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

  // The guardian to notify is the client's actual parent_id, NOT
  // reservation.created_by - a session generated by staff assigning a
  // recurring schedule (or any one-off staff booking) has created_by set to
  // the STAFF/ADMIN who made the API call, not the family. Notifying
  // created_by in that (very common) case would alert the wrong person
  // entirely and the guardian would never see it.
  const { data: notifyClient } = await db.from('clients').select('parent_id').eq('id', reservation.client_id).maybeSingle();
  const guardianId = notifyClient?.parent_id || null;

  if (excused) {
    // Excused means not the guardian's fault, they owe nothing for a session
    // that didn't happen, so any still-unpaid invoice for it must be removed
    // outright, same reasoning as a legitimate-reason cancellation (see
    // applyCancelSideEffects/PUT /reservations/:id). releaseSessionPaymentAsCredit
    // right after only handles the ALREADY-PAID case (credit carryover), it
    // never touches a pending one.
    await db.from('payments').delete().eq('reservation_id', reservation.id).eq('status', 'pending');
    const credited = await releaseSessionPaymentAsCredit(reservation, 'Excused absence');
    if (guardianId) {
      await notifyEvent(null, {
        title: 'Session excused',
        body: `Your session on ${reservation.date} at ${reservation.time_slot} was excused, no fee was charged.${credited ? ' Your payment for it will be applied to your next session.' : ''}`,
        icon: 'fa-circle-check',
        target_user: guardianId
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
      if (!feeErr && guardianId) {
        await notifyEvent(null, {
          title: 'No-show fee added',
          body: `A ₱${NO_SHOW_FEE} no-show fee was added for the missed session on ${reservation.date} at ${reservation.time_slot}.`,
          icon: 'fa-triangle-exclamation',
          target_user: guardianId
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

  // The guardian to notify is the client's actual parent_id, NOT
  // reservation.created_by - see applyNoShowSideEffects above for why.
  const { data: client } = await db.from('clients').select('full_name, parent_id').eq('id', reservation.client_id).maybeSingle();
  if (client?.parent_id && credited) {
    await notifyEvent(null, {
      title: 'Session cancelled, payment held as credit',
      body: `Your session on ${reservation.date} at ${reservation.time_slot} was cancelled. Your payment for it will be applied to your next session.`,
      icon: 'fa-circle-check',
      target_user: client.parent_id
    });
  }

  // A real, previously-confirmed therapy slot just opened back up, staff/admin
  // get flagged so they can offer it as a make-up session to a client who
  // needs one (e.g. from a recent excused absence), rather than it just
  // quietly sitting open until someone happens to notice on the calendar.
  if (reservation.session_type === 'Occupational Therapy' || reservation.session_type === 'Speech Therapy') {
    const body = `${reservation.session_type} on ${reservation.date} at ${reservation.time_slot}${reservation.therapist_name ? ' with ' + reservation.therapist_name : ''} just opened up (${client?.full_name || 'a client'}'s cancellation), free to offer as a make-up session.`;
    await notifyEvent(null, { title: 'Slot open for a make-up session', body, icon: 'fa-calendar-check', target_role: 'admin' });
    await notifyEvent(null, { title: 'Slot open for a make-up session', body, icon: 'fa-calendar-check', target_role: 'staff' });
  }

  await checkConsecutiveAbsences({ ...reservation, no_show_excused: true }, actorId);
}

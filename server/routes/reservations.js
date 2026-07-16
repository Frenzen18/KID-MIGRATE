import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getTherapistShifts, hourLabel, labelToHour, worksOn, isLunchHour } from './shifts.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent } from '../lib/notify.js';
import { rateFor, genInvoiceNo } from '../lib/billing.js';

const router = Router();
router.use(requireAuth);

const PAYMENT_METHODS = ['Unpaid', 'Cash', 'Check', 'QRPh'];

// A guardian's self-booking holds the slot as 'awaiting_payment' for this
// long while they complete QRPh checkout, server/lib/bookingHolds.js sweeps
// and releases any that expire unpaid.
export const BOOKING_HOLD_MINUTES = 15;

/** Assessment session types that must go to a therapist of a specific discipline. */
const SESSION_TYPE_ROLE = { 'Speech-Language Assessment': 'speech', 'Occupational Assessment': 'ot' };

/**
 * A confirmed session should have an invoice waiting for it. Creates one
 * payment per reservation (idempotent, a reschedule or a second confirm
 * call never produces a duplicate). Defaults to the standard session rate
 * and 'Unpaid'/'pending', but the booking admin/staff can override the
 * amount and method at booking time via `opts`.
 */
async function ensurePaymentForReservation(reservation, actorId, opts = {}) {
  const { data: existing } = await db.from('payments').select('id').eq('reservation_id', reservation.id).maybeSingle();
  if (existing) return existing;

  const amount = Number.isFinite(opts.amount) && opts.amount > 0 ? opts.amount : rateFor(reservation.session_type);
  const method = PAYMENT_METHODS.includes(opts.method) ? opts.method : 'Unpaid';
  // Only Cash/Check are money already in hand at approval time, mark those paid
  // immediately. QRPh (like Unpaid) still needs the actual PayMongo QR checkout
  // to complete before it's really paid; picking it here just records intent.
  const status = (method === 'Cash' || method === 'Check') ? 'paid' : 'pending';

  const invoice_no = genInvoiceNo();
  const { data, error } = await db.from('payments').insert({
    client_id: reservation.client_id,
    reservation_id: reservation.id,
    amount,
    method,
    status,
    invoice_no,
    paid_at: status === 'paid' ? new Date().toISOString() : null
  }).select().single();
  if (error) { console.error('Auto-invoice creation failed:', error.message); return null; }

  await logAudit({
    table_name: 'payments', record_id: data.id, action: 'create',
    description: `Invoice auto-generated for ${reservation.session_type} on ${reservation.date} ${reservation.time_slot} (${invoice_no})`,
    created_by: actorId
  });
  return data;
}

/**
 * Availability for one date, driven by therapist shifts:
 * an hourly slot exists wherever at least one therapist is on shift, and its
 * capacity is the number of therapists covering that hour. `reservation` is
 * kept (first active booking) for backward compatibility with older views.
 *
 * `restrictToTherapist` (a therapist's full_name) narrows this to just that
 * one therapist's own shift, used when the client being booked already has
 * an "Assigned Therapist" set, so slots/booking only ever reflect that
 * therapist's schedule instead of the whole clinic's combined capacity.
 */
async function slotInfoForDate(date, restrictToTherapist) {
  // Only therapists working on this weekday contribute capacity
  // (availability matrix: work_days Mon–Sat; Sundays the clinic is closed).
  let shifts = (await getTherapistShifts()).filter(s => worksOn(s, date));
  if (restrictToTherapist) shifts = shifts.filter(s => s.name === restrictToTherapist);
  if (!shifts.length) return [];

  const { data: active, error } = await db.from('reservations')
    .select('*, clients(full_name, client_code)')
    .eq('date', date)
    .not('status', 'in', '(cancelled,declined)');
  if (error) throw new Error(error.message);

  const minH = Math.min(...shifts.map(s => s.start_hour));
  const maxH = Math.max(...shifts.map(s => s.end_hour));
  const slots = [];
  for (let h = minH; h < maxH; h++) {
    const onShift = shifts.filter(s => s.start_hour <= h && h < s.end_hour);
    if (!onShift.length) continue;
    // Therapists on their lunch break this hour aren't bookable, but the slot
    // itself still shows (as a locked "Lunch Break" row) rather than vanishing,
    // so the schedule reads as intentionally blocked, not just empty.
    const bookable = onShift.filter(s => !isLunchHour(s, h));
    const onLunch = onShift.filter(s => isLunchHour(s, h));
    const lunchBreak = bookable.length === 0;
    const booked = (active || []).filter(r => labelToHour(r.time_slot) === h
      && (!restrictToTherapist || r.therapist_name === restrictToTherapist));
    slots.push({
      time_slot: hourLabel(h),
      hour: h,
      capacity: onShift.length,
      booked: booked.length,
      available: lunchBreak ? 0 : Math.max(0, bookable.length - booked.length),
      therapists: bookable.map(s => s.name),
      lunch_break: lunchBreak,
      lunch_therapists: onLunch.map(s => s.name),
      reservations: booked,
      reservation: booked[0] || null
    });
  }
  return slots;
}

/**
 * Picks the therapist for a booking at `slot`: a requested name (staff only)
 * if they're on shift and free, otherwise a random free on-shift therapist.
 * Returns { therapist_name } or { error }.
 */
function assignTherapist(slot, requestedName) {
  const takenNames = slot.reservations.map(r => r.therapist_name).filter(Boolean);
  if (requestedName) {
    if ((slot.lunch_therapists || []).includes(requestedName)) {
      return { error: `${requestedName} is on their lunch break at ${slot.time_slot}.` };
    }
    if (!slot.therapists.includes(requestedName)) {
      return { error: `${requestedName} is not on shift at ${slot.time_slot}.` };
    }
    if (takenNames.includes(requestedName)) {
      return { error: `${requestedName} already has a session at ${slot.time_slot}.` };
    }
    return { therapist_name: requestedName };
  }
  const free = slot.therapists.filter(n => !takenNames.includes(n));
  if (!free.length) return { error: 'That time slot is fully booked' };
  return { therapist_name: free[Math.floor(Math.random() * free.length)] };
}

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
/** True if the given "h:mm AM/PM" slot on `dateStr` has already passed in PH time. */
function isSlotPastPH(dateStr, timeLabel) {
  const today = todayPH();
  if (!dateStr || dateStr > today) return false;
  if (dateStr < today) return true;
  const m = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(String(timeLabel).trim());
  if (!m) return false;
  let [, h, min, ap] = m;
  h = parseInt(h, 10) % 12;
  if (/pm/i.test(ap)) h += 12;
  const slotMinutes = h * 60 + parseInt(min, 10);
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return slotMinutes <= nowMinutes;
}

/** GET /api/reservations?date=YYYY-MM-DD  or  ?from=&to=  or  ?status=pending */
router.get('/', async (req, res) => {
  let q = db.from('reservations').select('*, clients(full_name, client_code), payments(id, amount, status)').order('date').order('time_slot');
  if (req.query.date) q = q.eq('date', req.query.date);
  if (req.query.from) q = q.gte('date', req.query.from);
  if (req.query.to) q = q.lte('date', req.query.to);
  if (req.query.status) q = q.eq('status', req.query.status);
  if (req.query.client_id) q = q.eq('client_id', req.query.client_id);
  if (req.query.therapist_name) q = q.eq('therapist_name', req.query.therapist_name);
  if (req.user.role === 'parent') q = q.eq('created_by', req.user.id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * GET /api/reservations/slots?date=YYYY-MM-DD&client_id=|therapist_name=, shift-driven slot availability.
 * `therapist_name`, when given, narrows slots to that specific therapist's own
 * shift (used when staff explicitly picks a therapist, e.g. for an assessment).
 * Otherwise, when client_id is given and that client has an Assigned Therapist,
 * slots are narrowed to that therapist's own shift instead of the whole clinic's.
 */
router.get('/slots', async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date is required' });
  try {
    let restrictToTherapist = req.query.therapist_name || null;
    if (!restrictToTherapist && req.query.client_id) {
      const { data: client } = await db.from('clients').select('assigned_therapist_name').eq('id', req.query.client_id).maybeSingle();
      restrictToTherapist = client?.assigned_therapist_name || null;
    }
    res.json(await slotInfoForDate(date, restrictToTherapist));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/reservations, book a slot.
 * Staff/admin bookings confirm immediately. A guardian's own booking instead
 * holds the slot as 'awaiting_payment' (see BOOKING_HOLD_MINUTES) and only
 * becomes 'confirmed' once QRPh payment succeeds (server/lib/paymongoWebhook.js);
 * an unpaid hold past its deadline is auto-released (server/lib/bookingHolds.js).
 */
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.date || !b.time_slot || !b.client_id) {
    return res.status(400).json({ error: 'date, time_slot and client_id are required' });
  }

  // Bookings must be made at least a day ahead, same-day (and past) bookings aren't allowed.
  if (b.date <= todayPH()) {
    return res.status(400).json({ error: 'Bookings must be made at least a day in advance.' });
  }

  // Every booking needs the client's own record: to enforce that a parent may
  // only book for their own child, and, absent an explicit staff selection, to
  // keep the booking on the client's already-assigned therapist (if any)
  // rather than the clinic's combined capacity.
  const { data: bookingClient } = await db.from('clients').select('id, parent_id, full_name, assigned_therapist_name, therapy_type').eq('id', b.client_id).maybeSingle();
  if (!bookingClient) return res.status(404).json({ error: 'Client not found' });
  if (req.user.role === 'parent' && bookingClient.parent_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your child record' });
  }

  // Initial Assessment is for intake, only clients with neither a therapy type
  // nor an assigned therapist yet are eligible, anyone with either already set
  // has already been through intake.
  if (b.session_type === 'Initial Assessment' && (bookingClient.assigned_therapist_name || bookingClient.therapy_type)) {
    return res.status(400).json({ error: `${bookingClient.full_name} already has a therapy type and/or therapist assigned, not eligible for an Initial Assessment.` });
  }
  // Once a therapy type is assigned, intake is done, only sessions matching
  // that discipline (or Combined) may be booked, not a fresh Initial Assessment
  // or the other discipline's session type.
  if (bookingClient.therapy_type) {
    const allowed = { OT: ['Occupational Therapy'], Speech: ['Speech Therapy'], Both: ['Occupational Therapy', 'Speech Therapy'] }[bookingClient.therapy_type] || [];
    if (b.session_type && !allowed.includes(b.session_type) && !SESSION_TYPE_ROLE[b.session_type]) {
      return res.status(400).json({ error: `${bookingClient.full_name} is assigned to ${bookingClient.therapy_type} therapy, that session type isn't available for this client.` });
    }
  }

  const assignedTherapist = bookingClient.assigned_therapist_name || null;
  const isStaff = ['admin', 'staff'].includes(req.user.role);
  // An explicit staff selection (e.g. the therapist picked for a specific
  // assessment) always wins, it must never be silently swapped for the
  // client's Assigned Therapist from unrelated prior treatment. That field
  // only applies as a fallback when staff didn't request anyone specific.
  const requestedTherapist = (isStaff && b.therapist_name) ? b.therapist_name : assignedTherapist;

  const slots = await slotInfoForDate(b.date, requestedTherapist);
  const slot = slots.find(s => s.time_slot === b.time_slot);
  if (!slot) {
    return res.status(400).json({
      error: requestedTherapist
        ? `${requestedTherapist} is not on shift at that time.`
        : 'That time is outside the therapists\' shift hours.'
    });
  }

  // No bookings during a lunch break, checked explicitly (not just left to the
  // capacity guard below) so the rejection reason is unambiguous.
  if (slot.lunch_break) {
    return res.status(409).json({
      error: requestedTherapist
        ? `${requestedTherapist} is on their lunch break at that time.`
        : 'That time falls within the therapists\' lunch break, no bookings are allowed then.'
    });
  }

  // Parents can't book a slot that has already passed (server-side check, PH time UTC+8).
  if (req.user.role === 'parent' && isSlotPastPH(b.date, b.time_slot)) {
    return res.status(400).json({ error: 'That time slot has already passed.' });
  }

  // A client can only have one active booking per day, regardless of who's
  // booking (parent or staff), two sessions the same day isn't a real schedule.
  const { data: sameDayForChild } = await db.from('reservations')
    .select('id')
    .eq('client_id', b.client_id)
    .eq('date', b.date)
    .not('status', 'in', '(cancelled,declined)')
    .limit(1);
  if (sameDayForChild?.length) {
    return res.status(409).json({ error: `${bookingClient.full_name} already has a booking on ${b.date}.` });
  }

  // Anti-spam: a parent may only have ONE active (pending/confirmed/rescheduled)
  // upcoming request per child at a time. They must wait for staff to act on it
  // (or cancel it themselves) before submitting another, prevents flooding the
  // queue with repeat requests for the same therapist/slot.
  if (req.user.role === 'parent') {
    const today = todayPH();
    const { data: activeForChild } = await db.from('reservations')
      .select('id, date, time_slot, status')
      .eq('client_id', b.client_id)
      .eq('created_by', req.user.id)
      .in('status', ['awaiting_payment', 'pending', 'confirmed', 'rescheduled'])
      .gte('date', today)
      .limit(1);
    if (activeForChild?.length) {
      return res.status(409).json({
        error: 'You already have an upcoming booking for this child. Only one booking per child is allowed at a time, cancel it, or wait until its date has passed, before booking another.'
      });
    }
  }

  // Initial Assessment has no dedicated therapist picked ahead of time, so it's
  // capped at one booking per hour clinic-wide. Speech-Language/Occupational
  // Assessment already require picking a specific therapist first, so their
  // capacity is naturally just that therapist's own shift (checked below).
  if (b.session_type === 'Initial Assessment' && slot.reservations.some(r => r.session_type === 'Initial Assessment')) {
    return res.status(409).json({ error: 'Only one Initial Assessment can be booked per hour.' });
  }

  // Capacity guard: the slot holds as many sessions as therapists on shift.
  if (slot.available <= 0) return res.status(409).json({ error: 'That time slot is fully booked' });

  // Discipline-specific assessments must go to a therapist of the matching role.
  const requiredRole = SESSION_TYPE_ROLE[b.session_type];
  if (requiredRole && requestedTherapist) {
    const shiftsAll = await getTherapistShifts();
    const picked = shiftsAll.find(s => s.name === requestedTherapist);
    if (!picked || picked.role !== requiredRole) {
      return res.status(400).json({
        error: `${requestedTherapist} is not ${requiredRole === 'speech' ? 'a Speech-Language' : 'an Occupational'} therapist.`
      });
    }
  }

  // An explicit staff request (or the client's Assigned Therapist as fallback)
  // always wins; otherwise auto-assign a free on-shift therapist.
  const assigned = assignTherapist(slot, requestedTherapist);
  if (assigned.error) return res.status(409).json({ error: assigned.error });

  // Belt-and-suspenders double-booking guard: match date + time_slot + therapist
  // directly against the table, independent of the hour-bucketing above (which
  // relies on parsing time_slot into an hour and would silently miss a clash
  // if a stored time_slot ever doesn't match that exact format).
  const { data: clash } = await db.from('reservations')
    .select('id').eq('date', b.date).eq('time_slot', b.time_slot)
    .eq('therapist_name', assigned.therapist_name)
    .not('status', 'in', '(cancelled,declined)').limit(1);
  if (clash?.length) {
    return res.status(409).json({ error: `${assigned.therapist_name} already has a session at ${b.time_slot}.` });
  }

  // A guardian's own booking skips staff approval entirely, it holds the slot
  // as 'awaiting_payment' until QRPh checkout succeeds (or the hold expires).
  const holdExpiresAt = isStaff ? null : new Date(Date.now() + BOOKING_HOLD_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await db.from('reservations').insert({
    client_id: b.client_id,
    therapist_name: assigned.therapist_name,
    date: b.date,
    time_slot: b.time_slot,
    session_type: b.session_type || 'General Session',
    duration_min: b.duration_min || 60,
    room: b.room || null,
    status: isStaff ? 'confirmed' : 'awaiting_payment',
    channel: isStaff ? req.user.role : 'parent-portal',
    notes: b.notes || null,
    created_by: req.user.id,
    payment_expires_at: holdExpiresAt
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'reservations', record_id: data.id, action: 'create',
    description: `Booked ${data.session_type} for ${data.date} ${data.time_slot}`,
    created_by: req.user.id
  });

  let payment = null;
  if (data.status === 'confirmed') {
    await logAudit({
      table_name: 'reservations', record_id: data.id, action: 'approve',
      description: `Auto-confirmed by staff at booking (${data.date} ${data.time_slot})`,
      approved_by: req.user.id
    });
    // Staff booking a client directly means payment was already handled in
    // person (cash), the slot shouldn't sit "pending" waiting for a QRPh
    // checkout nobody's going to do, defaults to Cash/paid unless staff
    // explicitly picked a different method.
    const amt = Number(b.payment_amount);
    payment = await ensurePaymentForReservation(data, req.user.id, {
      amount: Number.isFinite(amt) ? amt : undefined,
      method: b.payment_method || 'Cash'
    });
  } else {
    // Guardian's slot is held, but not theirs yet, invoice is generated now
    // so the client can immediately kick off QRPh checkout for it.
    payment = await ensurePaymentForReservation(data, req.user.id, { method: 'QRPh' });
  }

  res.status(201).json({ ...data, payment });
});

/** PUT /api/reservations/:id, reschedule / approve / decline / cancel */
router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const { data: existing } = await db.from('reservations').select('*').eq('id', req.params.id).single();
  if (!existing) return res.status(404).json({ error: 'Reservation not found' });

  const isStaff = ['admin', 'staff'].includes(req.user.role);
  // parents may only cancel their own pending requests
  if (!isStaff && (existing.created_by !== req.user.id || b.status !== 'cancelled')) {
    return res.status(403).json({ error: 'Parents can only cancel their own requests' });
  }

  const patch = {};
  if (b.status) patch.status = b.status;
  if (b.therapist_name !== undefined) {
    const requiredRole = SESSION_TYPE_ROLE[existing.session_type];
    if (requiredRole && b.therapist_name) {
      const shiftsAll = await getTherapistShifts();
      const picked = shiftsAll.find(s => s.name === b.therapist_name);
      if (!picked || picked.role !== requiredRole) {
        return res.status(400).json({
          error: `${b.therapist_name} is not ${requiredRole === 'speech' ? 'a Speech-Language' : 'an Occupational'} therapist.`
        });
      }
    }
    patch.therapist_name = b.therapist_name;
  }
  if (b.room !== undefined) patch.room = b.room;
  if (b.notes !== undefined) patch.notes = b.notes;
  if (b.date && b.time_slot) {
    if (b.date <= todayPH()) {
      return res.status(400).json({ error: 'Bookings must be made at least a day in advance.' });
    }
    // A client can only have one active booking per day, same rule as new bookings.
    const { data: sameDayForChild } = await db.from('reservations')
      .select('id')
      .eq('client_id', existing.client_id)
      .eq('date', b.date)
      .neq('id', req.params.id)
      .not('status', 'in', '(cancelled,declined)')
      .limit(1);
    if (sameDayForChild?.length) {
      return res.status(409).json({ error: `This client already has a booking on ${b.date}.` });
    }
    // A reschedule keeps the reservation's own already-assigned therapist
    // whenever possible, it must never be silently swapped for the client's
    // Assigned Therapist field (that's an unrelated default for new bookings,
    // not a reason to reassign an existing session's therapist).
    const { data: reschedClient } = await db.from('clients').select('assigned_therapist_name').eq('id', existing.client_id).maybeSingle();
    const assignedTherapist = reschedClient?.assigned_therapist_name || null;
    const scopeTherapist = existing.therapist_name || assignedTherapist;

    const slots = await slotInfoForDate(b.date, scopeTherapist);
    const slot = slots.find(s => s.time_slot === b.time_slot);
    if (!slot) {
      return res.status(400).json({
        error: scopeTherapist
          ? `${scopeTherapist} is not on shift at that time.`
          : 'That time is outside the therapists\' shift hours.'
      });
    }
    // No rescheduling into a lunch break, checked explicitly for a clear reason.
    if (slot.lunch_break) {
      return res.status(409).json({
        error: scopeTherapist
          ? `${scopeTherapist} is on their lunch break at that time.`
          : 'That time falls within the therapists\' lunch break, no bookings are allowed then.'
      });
    }
    // Ignore this reservation itself when counting the target slot's load.
    slot.reservations = slot.reservations.filter(r => r.id !== req.params.id);
    slot.available = Math.max(0, slot.therapists.length - slot.reservations.length);

    if (existing.session_type === 'Initial Assessment' && slot.reservations.some(r => r.session_type === 'Initial Assessment')) {
      return res.status(409).json({ error: 'Only one Initial Assessment can be booked per hour.' });
    }
    if (slot.available <= 0) return res.status(409).json({ error: 'Target slot is fully booked' });

    // Keep the same therapist if they're free at the new time, else fall back
    // to the client's Assigned Therapist, else auto-assign.
    const keep = existing.therapist_name && slot.therapists.includes(existing.therapist_name)
      && !slot.reservations.some(r => r.therapist_name === existing.therapist_name);
    const assigned = keep
      ? { therapist_name: existing.therapist_name }
      : (assignedTherapist ? { therapist_name: assignedTherapist } : assignTherapist(slot, null));
    if (assigned.error) return res.status(409).json({ error: assigned.error });

    // Belt-and-suspenders double-booking guard, same as new bookings: match
    // date + time_slot + therapist directly against the table, independent of
    // the hour-bucketing above.
    const { data: clash } = await db.from('reservations')
      .select('id').eq('date', b.date).eq('time_slot', b.time_slot)
      .eq('therapist_name', assigned.therapist_name)
      .neq('id', req.params.id)
      .not('status', 'in', '(cancelled,declined)').limit(1);
    if (clash?.length) {
      return res.status(409).json({ error: `${assigned.therapist_name} already has a session at ${b.time_slot}.` });
    }

    patch.therapist_name = assigned.therapist_name;

    patch.date = b.date;
    patch.time_slot = b.time_slot;
    if (!b.status) patch.status = 'rescheduled';
  }

  const { data, error } = await db.from('reservations').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (patch.status === 'confirmed') {
    await logAudit({
      table_name: 'reservations', record_id: req.params.id, action: 'approve',
      description: `Reservation confirmed for ${data.date} ${data.time_slot}`,
      approved_by: req.user.id
    });
    const amt = Number(b.payment_amount);
    await ensurePaymentForReservation(data, req.user.id, {
      amount: Number.isFinite(amt) ? amt : undefined,
      method: b.payment_method || 'Cash'
    });
    if (existing.created_by) {
      await notifyEvent('notify_session_change', {
        title: 'Booking confirmed',
        body: `Your session on ${data.date} at ${data.time_slot} has been confirmed.`,
        icon: 'fa-calendar-check',
        target_user: existing.created_by
      });
    }
  } else {
    let description = `Reservation updated (${data.date} ${data.time_slot})`;
    if (patch.status === 'cancelled') description = `Reservation cancelled (${data.date} ${data.time_slot})`;
    else if (patch.status === 'declined') description = `Reservation declined (${data.date} ${data.time_slot})`;
    else if (patch.status === 'no_show') description = `Client marked no-show (${data.date} ${data.time_slot})`;
    else if (patch.date && patch.time_slot) description = `Reservation rescheduled to ${data.date} ${data.time_slot}`;
    await logAudit({
      table_name: 'reservations', record_id: req.params.id, action: 'update',
      description, updated_by: req.user.id
    });

    if (patch.status === 'no_show') {
      // Keep attendance-rate reporting (parent portal, admin reports) in sync
      // with the booking outcome, same table/shape as POST /clients/:id/attendance.
      await db.from('attendance').insert({ client_id: existing.client_id, session_date: existing.date, attended: false });
    }

    if (patch.status === 'cancelled' || patch.status === 'declined') {
      if (existing.status === 'awaiting_payment') {
        // Never paid, no financial record to keep, remove the invoice so it
        // doesn't linger unpaid in the guardian's Payments tab.
        await db.from('payments').delete().eq('reservation_id', existing.id).eq('status', 'pending');
      }
      const verb = patch.status === 'cancelled' ? 'cancelled' : 'declined';
      if (existing.created_by && existing.created_by !== req.user.id) {
        // Staff/admin cancelled or declined a parent's booking, let the parent know.
        await notifyEvent('notify_session_cancellation', {
          title: `Booking ${verb}`,
          body: `Your session on ${existing.date} at ${existing.time_slot} was ${verb}${b.notes ? ': ' + b.notes : '.'}`,
          icon: 'fa-calendar-xmark',
          target_user: existing.created_by
        });
      } else if (!isStaff) {
        // A parent cancelled their own pending request, let the front desk know.
        const body = `A parent cancelled their booking on ${existing.date} at ${existing.time_slot}.`;
        await notifyEvent('notify_session_cancellation', { title: 'Booking cancelled by parent', body, icon: 'fa-calendar-xmark', target_role: 'admin' });
        await notifyEvent('notify_session_cancellation', { title: 'Booking cancelled by parent', body, icon: 'fa-calendar-xmark', target_role: 'staff' });
      }
    } else if (patch.date && patch.time_slot && existing.created_by) {
      // Staff rescheduled an existing booking to a new date/time.
      await notifyEvent('notify_reschedule_request', {
        title: 'Session rescheduled',
        body: `Your session has been moved to ${data.date} at ${data.time_slot}.`,
        icon: 'fa-arrows-rotate',
        target_user: existing.created_by
      });
    }
  }

  res.json(data);
});

/** DELETE, admin only, hard delete */
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data: existing } = await db.from('reservations').select('date, time_slot').eq('id', req.params.id).maybeSingle();
  const { error } = await db.from('reservations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'reservations', record_id: req.params.id, action: 'delete',
    description: `Deleted reservation${existing ? ` (${existing.date} ${existing.time_slot})` : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

export default router;

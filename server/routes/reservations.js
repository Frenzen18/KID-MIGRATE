import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getTherapistShifts, hourLabel, labelToHour, worksOn, isLunchHour, workDayIndex } from './shifts.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent, therapistUserId } from '../lib/notify.js';
import { rateFor, genInvoiceNo } from '../lib/billing.js';

const router = Router();
router.use(requireAuth);

const PAYMENT_METHODS = ['Unpaid', 'Cash', 'Check', 'QRPh'];

// A guardian's self-booking holds the slot as 'awaiting_payment' for this
// long while they complete QRPh checkout, server/lib/bookingHolds.js sweeps
// and releases any that expire unpaid.
export const BOOKING_HOLD_MINUTES = 10;

/** Assessment session types that must go to a therapist of a specific discipline. */
const SESSION_TYPE_ROLE = { 'Speech-Language Assessment': 'speech', 'Occupational Assessment': 'ot' };

/** Which discipline a session type belongs to, null for discipline-agnostic types (e.g. Initial Assessment). */
function disciplineOfSessionType(type) {
  if (type === 'Occupational Therapy' || type === 'Occupational Assessment') return 'ot';
  if (type === 'Speech Therapy' || type === 'Speech-Language Assessment') return 'speech';
  return null;
}

/**
 * A Combined client carries two independent assigned therapists (one OT, one
 * Speech), never a single shared field, this picks the one matching the
 * session type being booked. An OT-only/Speech-only client simply only ever
 * has their own discipline's column populated.
 */
function assignedTherapistFor(client, sessionType) {
  const d = disciplineOfSessionType(sessionType);
  if (d === 'ot') return client.assigned_ot_therapist_name || null;
  if (d === 'speech') return client.assigned_speech_therapist_name || null;
  return null;
}

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

  const invoice_no = await genInvoiceNo();
  const { data, error } = await db.from('payments').insert({
    client_id: reservation.client_id,
    reservation_id: reservation.id,
    amount,
    method,
    status,
    invoice_no,
    paid_at: status === 'paid' ? new Date().toISOString() : null
  }).select().single();
  if (error) {
    // A concurrent call (e.g. a double-clicked Confirm) can lose the race here to
    // the DB's own unique index instead of the SELECT check above, return the
    // row the other call just created rather than erroring or double-invoicing.
    if (error.code === '23505') {
      const { data: winner } = await db.from('payments').select('id').eq('reservation_id', reservation.id).maybeSingle();
      if (winner) return winner;
    }
    console.error('Auto-invoice creation failed:', error.message);
    return null;
  }

  await logAudit({
    table_name: 'payments', record_id: data.id, action: 'create',
    description: `Invoice auto-generated for ${reservation.session_type} on ${reservation.date} ${reservation.time_slot} (${invoice_no})`,
    created_by: actorId
  });
  return data;
}

/** True if `date` is marked as a clinic-wide closure (see clinic_holidays table,
 *  managed on the Employee Scheduling tab). No booking of any kind, Initial
 *  Assessment or therapist-shift-driven, is allowed on a holiday. */
async function isClinicHoliday(date) {
  const { data, error } = await db.from('clinic_holidays').select('label').eq('date', date).maybeSingle();
  if (error) {
    // Don't silently treat a broken query (e.g. the clinic_holidays table not
    // existing yet, migration_clinic_holidays.sql not run) as "it's a holiday",
    // that would wrongly close every single day clinic-wide. Log and proceed
    // as if there's no holiday, the real fix is running the migration.
    console.error('isClinicHoliday query failed:', error.message);
    return null;
  }
  return data || null;
}

/**
 * The clinic's own operating hours for a given date (weekday/Saturday start+end
 * hour, from branding_settings, editable on the Employee Scheduling tab),
 * Sunday is always closed clinic-wide. Returns null when closed or unconfigured.
 */
async function getClinicHours(date) {
  const wd = workDayIndex(date); // Mon=0 … Sat=5, Sun=6
  if (wd === 6) return null;
  const { data, error } = await db.from('branding_settings')
    .select('clinic_weekday_start_hour, clinic_weekday_end_hour, clinic_saturday_start_hour, clinic_saturday_end_hour')
    .eq('id', 1).maybeSingle();
  if (error) {
    // Same reasoning as isClinicHoliday: a broken query (e.g. the
    // clinic_weekday_start_hour etc. columns not existing yet,
    // migration_clinic_operating_hours.sql not run) must not be silently
    // read as "the clinic has no configured hours, so it's closed" for
    // every single day. Surface it loudly instead.
    throw new Error('Failed to read clinic operating hours: ' + error.message + '. Has migration_clinic_operating_hours.sql been run?');
  }
  if (!data) return null;
  const [startH, endH] = wd === 5
    ? [data.clinic_saturday_start_hour, data.clinic_saturday_end_hour]
    : [data.clinic_weekday_start_hour, data.clinic_weekday_end_hour];
  if (startH == null || endH == null || startH >= endH) return null;
  return { start: startH, end: endH };
}

/**
 * Availability for one date. Regular sessions/discipline-specific assessments
 * stay driven by therapist shifts: an hourly slot exists wherever at least one
 * therapist is on shift, and its capacity is the number of therapists covering
 * that hour. `reservation` is kept (first active booking) for backward
 * compatibility with older views.
 *
 * `restrictToTherapist` (a therapist's full_name) narrows this to just that
 * one therapist's own shift, used when the client being booked already has
 * an "Assigned Therapist" set, so slots/booking only ever reflect that
 * therapist's schedule instead of the whole clinic's combined capacity.
 *
 * `serviceType === 'Initial Assessment'` instead generates slots from the
 * clinic's own operating hours (getClinicHours), not any specific therapist's
 * shift, intake has no dedicated therapist yet, so it shouldn't be limited to
 * whichever hours a therapist happens to already be scheduled. Capacity is a
 * flat 1 per hour, clinic-wide (same "only one Initial Assessment per hour"
 * rule as before).
 */
async function slotInfoForDate(date, restrictToTherapist, serviceType) {
  if (await isClinicHoliday(date)) return [];

  if (serviceType === 'Initial Assessment') {
    const hours = await getClinicHours(date);
    if (!hours) return [];
    const { data: active, error } = await db.from('reservations')
      .select('*, clients(full_name, client_code)')
      .eq('date', date).eq('session_type', 'Initial Assessment')
      .not('status', 'in', '(cancelled,declined)');
    if (error) throw new Error(error.message);

    // Clinic hours alone don't know about lunch, that's a per-therapist-shift
    // setting, an hour only actually has nobody free for intake when every
    // therapist on shift that hour is at lunch (an hour with no shift covering
    // it at all is left bookable, same clinic-wide-not-shift-dependent
    // reasoning as the rest of this branch).
    const shiftsAll = (await getTherapistShifts()).filter(s => worksOn(s, date));

    const slots = [];
    for (let h = hours.start; h < hours.end; h++) {
      const booked = (active || []).filter(r => labelToHour(r.time_slot) === h);
      const onShift = shiftsAll.filter(s => s.start_hour <= h && h < s.end_hour);
      const lunchBreak = onShift.length > 0 && onShift.every(s => isLunchHour(s, h));
      slots.push({
        time_slot: hourLabel(h),
        hour: h,
        capacity: 1,
        booked: booked.length,
        available: lunchBreak ? 0 : Math.max(0, 1 - booked.length),
        therapists: [],
        lunch_break: lunchBreak,
        lunch_therapists: lunchBreak ? onShift.map(s => s.name) : [],
        reservations: booked,
        reservation: booked[0] || null
      });
    }
    return slots;
  }

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
  let q = db.from('reservations').select('*, clients(full_name, client_code, guardian_name, guardian_phone), payments(id, amount, status, method, invoice_no, paid_at)').order('date').order('time_slot');
  if (req.query.date) q = q.eq('date', req.query.date);
  if (req.query.from) q = q.gte('date', req.query.from);
  if (req.query.to) q = q.lte('date', req.query.to);
  if (req.query.status) q = q.eq('status', req.query.status);
  if (req.query.client_id) q = q.eq('client_id', req.query.client_id);
  if (req.query.therapist_name) q = q.eq('therapist_name', req.query.therapist_name);
  if (req.user.role === 'parent') {
    // Scope to the parent's own children (by client_id), not just bookings they
    // personally created, a session staff/admin booked directly for the child
    // must still show up here, otherwise the parent portal's "already have an
    // upcoming booking" conflict check never sees it and lets them double-book.
    const { data: myClients } = await db.from('clients').select('id').eq('parent_id', req.user.id);
    const clientIds = (myClients || []).map(c => c.id);
    q = clientIds.length ? q.in('client_id', clientIds) : q.eq('id', '00000000-0000-0000-0000-000000000000');
  }
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
      const { data: client } = await db.from('clients')
        .select('assigned_ot_therapist_name, assigned_speech_therapist_name, therapy_type')
        .eq('id', req.query.client_id).maybeSingle();
      if (client) {
        // session_type tells us which of the client's two assigned therapists to
        // scope by; without it (e.g. an unassigned/single-discipline client) fall
        // back to whichever single discipline the client actually has.
        const fallbackType = req.query.session_type
          || (client.therapy_type === 'OT' ? 'Occupational Therapy' : client.therapy_type === 'Speech' ? 'Speech Therapy' : null);
        restrictToTherapist = assignedTherapistFor(client, fallbackType);
      }
    }
    res.json(await slotInfoForDate(date, restrictToTherapist, req.query.session_type));
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

  const holiday = await isClinicHoliday(b.date);
  if (holiday) {
    return res.status(400).json({ error: `The clinic is closed on ${b.date}${holiday.label ? ` (${holiday.label})` : ''}.` });
  }

  // Every booking needs the client's own record: to enforce that a parent may
  // only book for their own child, and, absent an explicit staff selection, to
  // keep the booking on the client's already-assigned therapist (if any)
  // rather than the clinic's combined capacity.
  const { data: bookingClient } = await db.from('clients').select('id, parent_id, full_name, assigned_ot_therapist_name, assigned_speech_therapist_name, therapy_type').eq('id', b.client_id).maybeSingle();
  if (!bookingClient) return res.status(404).json({ error: 'Client not found' });
  if (req.user.role === 'parent' && bookingClient.parent_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your child record' });
  }

  // Initial Assessment is for intake, only clients with neither a therapy type
  // nor an assigned therapist yet are eligible, anyone with either already set
  // has already been through intake.
  if (b.session_type === 'Initial Assessment' && (bookingClient.assigned_ot_therapist_name || bookingClient.assigned_speech_therapist_name || bookingClient.therapy_type)) {
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

  const assignedTherapist = assignedTherapistFor(bookingClient, b.session_type);
  const isStaff = ['admin', 'staff'].includes(req.user.role);
  // An explicit staff selection (e.g. the therapist picked for a specific
  // assessment) always wins, it must never be silently swapped for the
  // client's Assigned Therapist from unrelated prior treatment. That field
  // only applies as a fallback when staff didn't request anyone specific.
  const requestedTherapist = (isStaff && b.therapist_name) ? b.therapist_name : assignedTherapist;

  const slots = await slotInfoForDate(b.date, requestedTherapist, b.session_type);
  const slot = slots.find(s => s.time_slot === b.time_slot);
  if (!slot) {
    return res.status(400).json({
      error: requestedTherapist
        ? `${requestedTherapist} is not on shift at that time.`
        : b.session_type === 'Initial Assessment'
          ? 'That time is outside the clinic\'s operating hours.'
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
  // Exception: a Combined client may hold one OT session AND one Speech session
  // on the same day (different disciplines), just never two of the same discipline.
  const newDiscipline = disciplineOfSessionType(b.session_type);
  const { data: sameDayForChild } = await db.from('reservations')
    .select('id, session_type, time_slot')
    .eq('client_id', b.client_id)
    .eq('date', b.date)
    .not('status', 'in', '(cancelled,declined)');

  // A client can never be in two sessions at the exact same time, regardless of
  // discipline or therapist, this applies even to a Combined client's one-OT
  // + one-Speech-per-day exception below.
  if ((sameDayForChild || []).some(r => r.time_slot === b.time_slot)) {
    return res.status(409).json({ error: `${bookingClient.full_name} already has a session booked at ${b.time_slot} on ${b.date}.` });
  }

  // Two siblings booked into the same discipline at the exact same date+time
  // would need the same kind of specialist at once (OT vs OT, Speech vs
  // Speech), that's the real conflict, not the date+time alone, different
  // disciplines (e.g. one sibling's Initial Assessment and another's
  // Occupational Therapy) are entirely separate processes and can coexist
  // in the same slot just fine.
  if (bookingClient.parent_id && newDiscipline) {
    const { data: siblingClients } = await db.from('clients').select('id, full_name').eq('parent_id', bookingClient.parent_id).neq('id', b.client_id);
    const siblingIds = (siblingClients || []).map(c => c.id);
    if (siblingIds.length) {
      const { data: siblingSameSlot } = await db.from('reservations')
        .select('id, client_id, session_type')
        .in('client_id', siblingIds)
        .eq('date', b.date)
        .eq('time_slot', b.time_slot)
        .not('status', 'in', '(cancelled,declined)');
      const siblingConflict = (siblingSameSlot || []).find(r => disciplineOfSessionType(r.session_type) === newDiscipline);
      if (siblingConflict) {
        const conflictChild = siblingClients.find(c => c.id === siblingConflict.client_id);
        return res.status(409).json({ error: `${conflictChild?.full_name || 'Another one of your children'} already has a session booked at ${b.time_slot} on ${b.date}. Please pick a different time for ${bookingClient.full_name}.` });
      }
    }
  }

  const sameDayConflict = (bookingClient.therapy_type === 'Both' && newDiscipline)
    ? (sameDayForChild || []).some(r => disciplineOfSessionType(r.session_type) === newDiscipline)
    : (sameDayForChild || []).length > 0;
  if (sameDayConflict) {
    return res.status(409).json({ error: `${bookingClient.full_name} already has a${newDiscipline ? ' ' + (newDiscipline === 'speech' ? 'Speech-Language' : 'Occupational') : ''} booking on ${b.date}.` });
  }

  // Anti-spam: a parent may only have ONE active (pending/confirmed/rescheduled)
  // upcoming booking per child at a time (per discipline, for a Combined child),
  // whether it's their own self-booked request or one staff/admin booked
  // directly for the child, either way the child's already got a session that
  // date/discipline. They must wait for it to pass (or cancel it) before
  // submitting another, prevents flooding the queue with repeat requests for
  // the same therapist/slot.
  if (req.user.role === 'parent') {
    const today = todayPH();
    const { data: activeForChild } = await db.from('reservations')
      .select('id, date, time_slot, status, session_type')
      .eq('client_id', b.client_id)
      .in('status', ['awaiting_payment', 'pending', 'confirmed', 'rescheduled'])
      .gte('date', today);
    const activeConflict = (bookingClient.therapy_type === 'Both' && newDiscipline)
      ? (activeForChild || []).some(r => disciplineOfSessionType(r.session_type) === newDiscipline)
      : (activeForChild || []).length > 0;
    if (activeConflict) {
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
  // always wins; otherwise auto-assign a free on-shift therapist. Initial
  // Assessment is intake/triage, though, the whole point is to decide which
  // therapist/discipline fits the child, so unless staff explicitly picked
  // someone, it's intentionally left unassigned rather than random-assigned,
  // an admin/staff assigns a therapist afterward based on the assessment.
  const assigned = (b.session_type === 'Initial Assessment' && !requestedTherapist)
    ? { therapist_name: null }
    : assignTherapist(slot, requestedTherapist);
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
  if (error) {
    // A concurrent request can slip past the SELECT-based clash checks above
    // and lose the race at the DB's unique index instead, this turns that
    // into the same friendly message the earlier checks already use rather
    // than a raw Postgres constraint-violation string. Initial Assessment has
    // no therapist_name to blame (reservations_active_ia_slot_uidx instead of
    // reservations_active_slot_therapist_uidx), so it gets its own message
    // matching the read-based check above.
    if (error.code === '23505') {
      return res.status(409).json({
        error: b.session_type === 'Initial Assessment'
          ? 'Only one Initial Assessment can be booked per hour.'
          : `${assigned.therapist_name || 'That therapist'} already has a session at ${b.time_slot}.`
      });
    }
    return res.status(500).json({ error: error.message });
  }

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
    // Staff bookings confirm immediately, the therapist's schedule just
    // changed right now, not on some future payment/approval step, tell them.
    const therapistId = await therapistUserId(data.therapist_name);
    if (therapistId) {
      await notifyEvent('notify_session_change', {
        title: 'New session booked',
        body: `${bookingClient.full_name}'s ${data.session_type} session on ${data.date} at ${data.time_slot} was added to your schedule.`,
        icon: 'fa-calendar-check',
        target_user: therapistId
      });
    }
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
    const holiday = await isClinicHoliday(b.date);
    if (holiday) {
      return res.status(400).json({ error: `The clinic is closed on ${b.date}${holiday.label ? ` (${holiday.label})` : ''}.` });
    }
    // A reschedule keeps the reservation's own already-assigned therapist
    // whenever possible, it must never be silently swapped for the client's
    // Assigned Therapist field (that's an unrelated default for new bookings,
    // not a reason to reassign an existing session's therapist).
    const { data: reschedClient } = await db.from('clients')
      .select('parent_id, assigned_ot_therapist_name, assigned_speech_therapist_name, therapy_type')
      .eq('id', existing.client_id).maybeSingle();
    const assignedTherapist = assignedTherapistFor(reschedClient || {}, existing.session_type);
    const scopeTherapist = existing.therapist_name || assignedTherapist;

    // A client can only have one active booking per day, same rule as new bookings,
    // with the same Combined-client exception (one OT + one Speech same day is fine).
    const existingDiscipline = disciplineOfSessionType(existing.session_type);
    const { data: sameDayForChild } = await db.from('reservations')
      .select('id, session_type, time_slot')
      .eq('client_id', existing.client_id)
      .eq('date', b.date)
      .neq('id', req.params.id)
      .not('status', 'in', '(cancelled,declined)');

    // A client can never be in two sessions at the exact same time, regardless of
    // discipline or therapist, even under the Combined one-OT + one-Speech-per-day exception.
    if ((sameDayForChild || []).some(r => r.time_slot === b.time_slot)) {
      return res.status(409).json({ error: `This client already has a session booked at ${b.time_slot} on ${b.date}.` });
    }

    // Same same-discipline sibling check as new bookings: rescheduling this
    // child into a slot where a sibling already has the SAME discipline is a
    // real conflict (both need the same kind of specialist at once), a
    // different discipline is a separate process and can share the slot.
    if (reschedClient?.parent_id && existingDiscipline) {
      const { data: siblingClients } = await db.from('clients').select('id, full_name').eq('parent_id', reschedClient.parent_id).neq('id', existing.client_id);
      const siblingIds = (siblingClients || []).map(c => c.id);
      if (siblingIds.length) {
        const { data: siblingSameSlot } = await db.from('reservations')
          .select('id, client_id, session_type')
          .in('client_id', siblingIds)
          .eq('date', b.date)
          .eq('time_slot', b.time_slot)
          .not('status', 'in', '(cancelled,declined)');
        const siblingConflict = (siblingSameSlot || []).find(r => disciplineOfSessionType(r.session_type) === existingDiscipline);
        if (siblingConflict) {
          const conflictChild = siblingClients.find(c => c.id === siblingConflict.client_id);
          return res.status(409).json({ error: `${conflictChild?.full_name || 'A sibling'} already has a session booked at ${b.time_slot} on ${b.date}. Please pick a different time.` });
        }
      }
    }

    const sameDayConflict = (reschedClient?.therapy_type === 'Both' && existingDiscipline)
      ? (sameDayForChild || []).some(r => disciplineOfSessionType(r.session_type) === existingDiscipline)
      : (sameDayForChild || []).length > 0;
    if (sameDayConflict) {
      return res.status(409).json({ error: `This client already has a booking on ${b.date}.` });
    }

    const slots = await slotInfoForDate(b.date, scopeTherapist, existing.session_type);
    const slot = slots.find(s => s.time_slot === b.time_slot);
    if (!slot) {
      return res.status(400).json({
        error: scopeTherapist
          ? `${scopeTherapist} is not on shift at that time.`
          : existing.session_type === 'Initial Assessment'
            ? 'That time is outside the clinic\'s operating hours.'
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
    slot.available = Math.max(0, slot.capacity - slot.reservations.length);

    if (existing.session_type === 'Initial Assessment' && slot.reservations.some(r => r.session_type === 'Initial Assessment')) {
      return res.status(409).json({ error: 'Only one Initial Assessment can be booked per hour.' });
    }
    if (slot.available <= 0) return res.status(409).json({ error: 'Target slot is fully booked' });

    // Keep the same therapist if they're free at the new time, else fall back
    // to the client's Assigned Therapist, else auto-assign, except an Initial
    // Assessment, which stays unassigned (same reasoning as new bookings above)
    // rather than picking someone at random just because it's moving times.
    const keep = existing.therapist_name && slot.therapists.includes(existing.therapist_name)
      && !slot.reservations.some(r => r.therapist_name === existing.therapist_name);
    const assigned = keep
      ? { therapist_name: existing.therapist_name }
      : assignedTherapist
        ? { therapist_name: assignedTherapist }
        : existing.session_type === 'Initial Assessment'
          ? { therapist_name: null }
          : assignTherapist(slot, null);
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
  if (error) {
    // Same concurrent-request race as new bookings: a reschedule can slip past
    // the SELECT-based clash checks above and lose the race at the DB's unique
    // index instead, this turns that into the same friendly message rather
    // than a raw Postgres constraint-violation string.
    if (error.code === '23505') {
      return res.status(409).json({
        error: patch.time_slot && existing.session_type === 'Initial Assessment'
          ? 'Only one Initial Assessment can be booked per hour.'
          : `${patch.therapist_name || 'That therapist'} already has a session at ${b.time_slot}.`
      });
    }
    return res.status(500).json({ error: error.message });
  }

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
    const confirmedTherapistId = await therapistUserId(data.therapist_name);
    if (confirmedTherapistId) {
      const { data: confClient } = await db.from('clients').select('full_name').eq('id', data.client_id).maybeSingle();
      await notifyEvent('notify_session_change', {
        title: 'New session confirmed',
        body: `${confClient?.full_name || 'A client'}'s ${data.session_type} session on ${data.date} at ${data.time_slot} is now confirmed on your schedule.`,
        icon: 'fa-calendar-check',
        target_user: confirmedTherapistId
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
      // The assigned therapist had this on their own schedule too, whoever
      // cancelled/declined it (parent or staff), they need it off their calendar.
      if (existing.status === 'confirmed' || existing.status === 'rescheduled') {
        const cancelledTherapistId = await therapistUserId(existing.therapist_name);
        if (cancelledTherapistId) {
          await notifyEvent('notify_session_cancellation', {
            title: `Session ${verb}`,
            body: `The session on ${existing.date} at ${existing.time_slot} was ${verb}${b.notes ? ': ' + b.notes : '.'}`,
            icon: 'fa-calendar-xmark',
            target_user: cancelledTherapistId
          });
        }
      }
    } else if (patch.date && patch.time_slot) {
      if (existing.created_by) {
        // Staff rescheduled an existing booking to a new date/time.
        await notifyEvent('notify_reschedule_request', {
          title: 'Session rescheduled',
          body: `Your session has been moved to ${data.date} at ${data.time_slot}.`,
          icon: 'fa-arrows-rotate',
          target_user: existing.created_by
        });
      }
      // Notify whoever's actually assigned after the move, same person as
      // before if they kept their slot, someone new if reassignment happened.
      const reschedTherapistId = await therapistUserId(patch.therapist_name);
      if (reschedTherapistId) {
        await notifyEvent('notify_reschedule_request', {
          title: 'Session rescheduled',
          body: `A session was moved to ${data.date} at ${data.time_slot} on your schedule.`,
          icon: 'fa-arrows-rotate',
          target_user: reschedTherapistId
        });
      }
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

import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getTherapistShifts, hourLabel, labelToHour, worksOn, isLunchHour, workDayIndex } from './shifts.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent, therapistUserId } from '../lib/notify.js';
import { rateFor, genInvoiceNo } from '../lib/billing.js';
import { applyNoShowSideEffects, applyCancelSideEffects } from '../lib/noShow.js';
import { dischargeSchedule } from '../lib/recurringSchedules.js';

const router = Router();
router.use(requireAuth);

const PAYMENT_METHODS = ['Unpaid', 'Cash', 'Check', 'QRPh'];

// A guardian's self-booking holds the slot as 'awaiting_payment' for this
// long while they complete QRPh checkout, server/lib/bookingHolds.js sweeps
// and releases any that expire unpaid.
export const BOOKING_HOLD_MINUTES = 10;

/** Assessment session types that must go to a therapist of a specific discipline. */
const SESSION_TYPE_ROLE = { 'Speech-Language Assessment': 'speech', 'Occupational Assessment': 'ot' };

/** Clinic-wide intake-style assessments with no dedicated therapist and shared
 *  one-per-hour capacity (see slotInfoForDate), as opposed to a regular
 *  session or a discipline-specific assessment that needs one particular
 *  therapist's own shift. */
const CLINIC_WIDE_ASSESSMENT_TYPES = ['Initial Assessment'];

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
  const { data: existing } = await db.from('payments').select('id').eq('reservation_id', reservation.id).eq('fee_type', 'session').maybeSingle();
  if (existing) return existing;

  // An excused no-show's already-paid invoice becomes a floating credit
  // (reservation_id null, still status 'paid'), rather than the guardian
  // paying twice, the oldest one on file gets applied to this new session
  // automatically instead of billing it fresh.
  const { data: credit } = await db.from('payments').select('*')
    .eq('client_id', reservation.client_id).eq('fee_type', 'session').eq('status', 'paid')
    .is('reservation_id', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (credit) {
    const { data: attached, error: attachErr } = await db.from('payments').update({ reservation_id: reservation.id }).eq('id', credit.id).select().single();
    if (!attachErr) {
      await logAudit({
        table_name: 'payments', record_id: credit.id, action: 'update',
        description: `Credit from an excused absence applied to ${reservation.session_type} on ${reservation.date} ${reservation.time_slot} (${credit.invoice_no})`,
        created_by: actorId
      });
      return attached;
    }
  }

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
    fee_type: 'session',
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
      const { data: winner } = await db.from('payments').select('id').eq('reservation_id', reservation.id).eq('fee_type', 'session').maybeSingle();
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

  if (CLINIC_WIDE_ASSESSMENT_TYPES.includes(serviceType)) {
    const hours = await getClinicHours(date);
    if (!hours) return [];
    const { data: active, error } = await db.from('reservations')
      .select('*, clients(full_name, client_code)')
      .eq('date', date).in('session_type', CLINIC_WIDE_ASSESSMENT_TYPES)
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

  // Per the clinic's Memorandum of Agreement (slot forfeiture after 3
  // consecutive missed sessions): a parent can't self-book another session for
  // a child whose last 3 completed-or-no-show sessions were all no-shows, one
  // real attendance resets it. Staff/admin are exempt, this is deliberately
  // only a self-service gate, the clinic can still book the child directly
  // once the family has sorted things out, there's no in-app "unlock" step.
  if (req.user.role === 'parent') {
    const { data: recentOutcomes } = await db.from('reservations')
      .select('status')
      .eq('client_id', b.client_id)
      .in('status', ['completed', 'no_show'])
      .order('date', { ascending: false })
      .limit(3);
    if ((recentOutcomes || []).length >= 3 && recentOutcomes.every(r => r.status === 'no_show')) {
      return res.status(403).json({
        error: `${bookingClient.full_name} has missed the last 3 scheduled sessions. Please contact the clinic directly to resume booking.`
      });
    }
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
  const isStaff = ['admin', 'staff'].includes(req.user.role);
  // A discipline requires a fixed weekly schedule to be assigned before a
  // guardian can self-book it at all, therapy_type/assigned_therapist_name
  // alone (which can be stale, e.g. after a discharge) is never enough. Once
  // assigned, self-booking is only allowed into that exact day-of-week +
  // time-slot, staff already picked the therapist and time. A discipline can
  // have more than one active schedule (policy: 1 session per therapist per
  // week, so 2x/week needs 2 different therapists), the guardian just needs
  // to match ANY one of their assigned slots. They can book several weeks
  // ahead at once (no "one upcoming booking" limit for this discipline, see
  // the activeConflict check below). Any other day/time is rejected, call
  // the clinic to change it. Staff aren't restricted to the assigned slot
  // (they might be fixing a one-off scheduling issue), but if what they pick
  // happens to match it anyway, it's still treated as the same kind of
  // booking (confirmed immediately, payment tracked separately, see below).
  let lockedSchedule = null;
  if (b.session_type === 'Occupational Therapy' || b.session_type === 'Speech Therapy') {
    const scheduleDiscipline = b.session_type === 'Occupational Therapy' ? 'OT' : 'Speech';
    const { data: activeSchedules } = await db.from('recurring_schedules')
      .select('id, day_of_week, time_slot, therapist_name')
      .eq('client_id', b.client_id).eq('discipline', scheduleDiscipline).eq('status', 'active');
    if (req.user.role === 'parent') {
      if (!activeSchedules || !activeSchedules.length) {
        return res.status(403).json({
          error: `${bookingClient.full_name} doesn't have a fixed ${b.session_type} schedule assigned yet. Please contact the clinic to get one set up.`
        });
      }
      const bookingWeekday = new Date(b.date + 'T00:00:00Z').getUTCDay();
      lockedSchedule = activeSchedules.find(s => s.day_of_week === bookingWeekday && s.time_slot === b.time_slot);
      if (!lockedSchedule) {
        const options = activeSchedules.map(s => `${WEEKDAY_NAMES[s.day_of_week]}s at ${s.time_slot} with ${s.therapist_name}`).join('; ');
        return res.status(403).json({
          error: `${bookingClient.full_name}'s ${b.session_type} schedule is fixed to: ${options}. Please call the clinic to change it.`
        });
      }
    } else {
      const bookingWeekday = new Date(b.date + 'T00:00:00Z').getUTCDay();
      lockedSchedule = (activeSchedules || []).find(s => s.day_of_week === bookingWeekday && s.time_slot === b.time_slot) || null;
    }
  }
  const assignedTherapist = assignedTherapistFor(bookingClient, b.session_type);
  // An explicit staff selection (e.g. overriding who a slot goes to) always
  // wins, staff isn't bound by any schedule lock. Absent that, a guardian's
  // locked-schedule booking uses that exact schedule's own therapist (a
  // discipline can have more than one, different day/times, so the single
  // assigned_*_therapist_name field alone can't be trusted here), otherwise
  // falls back to the client's Assigned Therapist.
  const requestedTherapist = (isStaff && b.therapist_name) ? b.therapist_name : lockedSchedule ? lockedSchedule.therapist_name : assignedTherapist;

  const slots = await slotInfoForDate(b.date, requestedTherapist, b.session_type);
  const slot = slots.find(s => s.time_slot === b.time_slot);
  if (!slot) {
    return res.status(400).json({
      error: requestedTherapist
        ? `${requestedTherapist} is not on shift at that time.`
        : CLINIC_WIDE_ASSESSMENT_TYPES.includes(b.session_type)
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
  // the same therapist/slot. Exempt for a discipline locked to a fixed
  // recurring schedule, the whole point there is stacking several future
  // occurrences of that same slot at once.
  if (req.user.role === 'parent' && !lockedSchedule) {
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

  // Initial Assessment has no dedicated therapist picked ahead of time, so
  // it's capped at one booking per hour clinic-wide. Speech-Language/
  // Occupational Assessment already require picking a specific therapist
  // first, so their capacity is naturally just that therapist's own shift
  // (checked below).
  if (CLINIC_WIDE_ASSESSMENT_TYPES.includes(b.session_type) && slot.reservations.some(r => CLINIC_WIDE_ASSESSMENT_TYPES.includes(r.session_type))) {
    return res.status(409).json({ error: `Only one ${b.session_type} can be booked per hour.` });
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
  const assigned = (CLINIC_WIDE_ASSESSMENT_TYPES.includes(b.session_type) && !requestedTherapist)
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

  // A guardian's own one-off booking skips staff approval entirely, it holds
  // the slot as 'awaiting_payment' until QRPh checkout succeeds (or the hold
  // expires). A booking into a fixed recurring slot is different: the slot is
  // guaranteed theirs the moment they book it (confirmed immediately, no
  // expiry risk), payment is tracked completely separately and can lag behind,
  // same for staff booking into that slot on a guardian's behalf.
  const isRecurringBooking = !!lockedSchedule;
  const holdExpiresAt = (isStaff || isRecurringBooking) ? null : new Date(Date.now() + BOOKING_HOLD_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await db.from('reservations').insert({
    client_id: b.client_id,
    therapist_name: assigned.therapist_name,
    date: b.date,
    time_slot: b.time_slot,
    session_type: b.session_type || 'General Session',
    duration_min: b.duration_min || 60,
    room: b.room || null,
    status: (isStaff || isRecurringBooking) ? 'confirmed' : 'awaiting_payment',
    channel: isStaff ? req.user.role : 'parent-portal',
    notes: b.notes || null,
    created_by: req.user.id,
    payment_expires_at: holdExpiresAt,
    recurring_schedule_id: lockedSchedule?.id || null
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
        error: CLINIC_WIDE_ASSESSMENT_TYPES.includes(b.session_type)
          ? `Only one ${b.session_type} can be booked per hour.`
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
      description: `Auto-confirmed${isRecurringBooking ? ' (fixed schedule slot)' : ' by staff'} at booking (${data.date} ${data.time_slot})`,
      approved_by: req.user.id
    });
    if (isRecurringBooking) {
      // Confirmed the instant it's booked, but payment is tracked completely
      // independently, defaults Unpaid/pending regardless of who booked it,
      // the guardian pays via QRPh (marks it "Online" once it clears) or staff
      // records it later from the Payments tab once actually collected (Cash/Check, "Offline").
      payment = await ensurePaymentForReservation(data, req.user.id, { method: b.payment_method });
    } else {
      // Staff booking a client directly for anything else means payment was
      // already handled in person (cash), the slot shouldn't sit "pending"
      // waiting for a QRPh checkout nobody's going to do, defaults to
      // Cash/paid unless staff explicitly picked a different method.
      const amt = Number(b.payment_amount);
      payment = await ensurePaymentForReservation(data, req.user.id, {
        amount: Number.isFinite(amt) ? amt : undefined,
        method: b.payment_method || 'Cash'
      });
    }
    // The therapist's schedule just changed right now, not on some future
    // payment/approval step, tell them regardless of who booked it.
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
  // A session booked into a fixed recurring schedule can't be self-cancelled,
  // per the MOA the guardian calls the clinic (with their reason) and staff
  // decides whether it's legitimate (credited) or not (see applyCancelSideEffects).
  if (!isStaff && b.status === 'cancelled' && existing.recurring_schedule_id) {
    return res.status(403).json({ error: 'This session is part of a fixed schedule and can\'t be self-cancelled. Please call the clinic to reschedule or cancel it.' });
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
          : CLINIC_WIDE_ASSESSMENT_TYPES.includes(existing.session_type)
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

    if (CLINIC_WIDE_ASSESSMENT_TYPES.includes(existing.session_type) && slot.reservations.some(r => CLINIC_WIDE_ASSESSMENT_TYPES.includes(r.session_type))) {
      return res.status(409).json({ error: `Only one ${existing.session_type} can be booked per hour.` });
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
        : CLINIC_WIDE_ASSESSMENT_TYPES.includes(existing.session_type)
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
        error: patch.time_slot && CLINIC_WIDE_ASSESSMENT_TYPES.includes(existing.session_type)
          ? `Only one ${existing.session_type} can be booked per hour.`
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
    else if (patch.status === 'no_show') description = `Client marked no-show, ${b.excused === true ? 'excused' : 'unexcused'} (${data.date} ${data.time_slot})`;
    else if (patch.status === 'completed') description = `Reservation marked completed (${data.date} ${data.time_slot})`;
    else if (patch.date && patch.time_slot) description = `Reservation rescheduled to ${data.date} ${data.time_slot}`;
    await logAudit({
      table_name: 'reservations', record_id: req.params.id, action: 'update',
      description, updated_by: req.user.id
    });

    // Idempotent (checks for an existing no-show fee before inserting), a
    // double PUT (retry, double-click) never creates a second fee.
    if (patch.status === 'no_show') await applyNoShowSideEffects(existing, { excused: b.excused === true, actorId: req.user.id });

    // A regular therapy session tied to a fixed recurring schedule just runs
    // the count up for staff's own reference, there's no cap to hit anymore,
    // the schedule stays active indefinitely until staff discharges it by hand.
    if (patch.status === 'completed' && existing.recurring_schedule_id) {
      const { data: schedule } = await db.from('recurring_schedules').select('sessions_completed').eq('id', existing.recurring_schedule_id).maybeSingle();
      if (schedule) {
        await db.from('recurring_schedules').update({ sessions_completed: (schedule.sessions_completed || 0) + 1 }).eq('id', existing.recurring_schedule_id);
      }
    }

    if (patch.status === 'cancelled' || patch.status === 'declined') {
      if (existing.status === 'awaiting_payment') {
        // Never paid, no financial record to keep, remove the invoice so it
        // doesn't linger unpaid in the guardian's Payments tab.
        await db.from('payments').delete().eq('reservation_id', existing.id).eq('status', 'pending');
      } else if (patch.status === 'cancelled') {
        // A confirmed (already paid or billed) session being cancelled is, by
        // definition, for a legitimate reason, staff cancelling it on the
        // guardian's behalf, not the guardian's own pending request being
        // withdrawn. Releases any paid invoice as a credit for their next
        // session, and counts toward the 3-consecutive-absence policy.
        await applyCancelSideEffects(existing, req.user.id);
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

/**
 * POST /api/reservations/:clientId/assign-schedule, admin/staff only. Pins a
 * client's discipline to a fixed weekly day/time/therapist indefinitely,
 * nobody can predict up front how many sessions a child will actually need,
 * so this never generates any reservations or invoices itself, it's just the
 * standing rule the guardian's own self-booking checks against from here on
 * (see the recurring-schedule guard in POST /). Requires the client's Initial
 * Assessment to already be completed, and checks the therapist actually works
 * that weekday/hour (a general shift check, not per-date, there's no fixed
 * batch of dates to validate anymore).
 */
router.post('/:clientId/assign-schedule', requireRole('admin', 'staff'), async (req, res) => {
  const b = req.body || {};
  const { discipline, therapist_name, day_of_week, time_slot } = b;
  if (!discipline || !['OT', 'Speech'].includes(discipline)) {
    return res.status(400).json({ error: 'discipline must be "OT" or "Speech"' });
  }
  if (!therapist_name) return res.status(400).json({ error: 'therapist_name is required' });
  if (!Number.isInteger(day_of_week) || day_of_week < 0 || day_of_week > 6) {
    return res.status(400).json({ error: 'day_of_week must be 0 (Sunday) through 6 (Saturday)' });
  }
  if (!time_slot) return res.status(400).json({ error: 'time_slot is required' });

  const { data: client, error: clientErr } = await db.from('clients')
    .select('id, full_name, parent_id, therapy_type, assigned_ot_therapist_name, assigned_speech_therapist_name, recommended_ot_weekly_sessions, recommended_speech_weekly_sessions, initial_assessment_completed')
    .eq('id', req.params.clientId).maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Normally driven by an actual completed "Initial Assessment" reservation,
  // but staff can also flip clients.initial_assessment_completed by hand (Edit
  // Client Profile) for intake that happened before this system was in use,
  // or to correct a data-entry mistake, without fabricating a fake reservation.
  if (!client.initial_assessment_completed) {
    const { data: initialAssessment } = await db.from('reservations')
      .select('id').eq('client_id', client.id).eq('session_type', 'Initial Assessment').eq('status', 'completed').maybeSingle();
    if (!initialAssessment) {
      return res.status(400).json({ error: `${client.full_name} must complete an Initial Assessment before a therapy schedule can be assigned.` });
    }
  }

  // The picker on the client already only offers role-matching therapists,
  // this is the server-side backstop so an OT discipline schedule can never
  // end up pinned to a Speech therapist (or vice versa) regardless of how
  // the request was made.
  const requiredRole = discipline === 'OT' ? 'ot' : 'speech';
  const shiftsAll = await getTherapistShifts();
  const pickedTherapist = shiftsAll.find(s => s.name === therapist_name);
  if (!pickedTherapist || pickedTherapist.role !== requiredRole) {
    return res.status(400).json({
      error: `${therapist_name} is not ${requiredRole === 'speech' ? 'a Speech-Language' : 'an Occupational'} therapist.`
    });
  }

  const sessionType = discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const { data: activeForClient } = await db.from('recurring_schedules')
    .select('id, discipline, therapist_name, day_of_week, time_slot').eq('client_id', client.id).eq('status', 'active');

  // A discipline can have more than one active schedule (1 session per
  // therapist per week policy, 2x/week needs 2 different therapists on
  // different days/times), but never the SAME therapist twice for this
  // client, that would just be 2 sessions/week with one person, against policy.
  if ((activeForClient || []).some(s => s.therapist_name === therapist_name)) {
    return res.status(409).json({ error: `${therapist_name} already has an active schedule with ${client.full_name}, one session per therapist per week.` });
  }

  // The child can only be in one session at a time, so a new schedule can
  // never land on a day/time they're already committed to, regardless of
  // discipline or therapist (e.g. a Combined client's 2nd weekly OT session,
  // or their Speech schedule, must fall on a different day/time than any
  // schedule they already have, not just a different one from the same discipline).
  const sameSlotForClient = (activeForClient || []).find(s => s.day_of_week === day_of_week && s.time_slot === time_slot);
  if (sameSlotForClient) {
    const conflictType = sameSlotForClient.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
    return res.status(409).json({
      error: `${client.full_name} already has a ${conflictType} schedule ${WEEKDAY_NAMES[day_of_week]}s at ${time_slot} with ${sameSlotForClient.therapist_name}. Pick a different day or time.`
    });
  }

  // Once a weekly-frequency recommendation is on file for this discipline, it's
  // a real cap, not just a note, staff has to discharge an existing schedule
  // (or raise the recommendation) before adding another beyond it.
  const recommended = discipline === 'OT' ? client.recommended_ot_weekly_sessions : client.recommended_speech_weekly_sessions;
  const currentCount = (activeForClient || []).filter(s => s.discipline === discipline).length;
  if (recommended != null && currentCount >= recommended) {
    return res.status(409).json({
      error: `${client.full_name} already has ${currentCount} of ${recommended} recommended weekly ${sessionType} session(s) assigned. Discharge one first, or update the recommendation.`
    });
  }

  // Only one client can actually occupy a given therapist's weekly hour, two
  // active schedules sharing the same day/time/therapist would just compete
  // for the same real calendar slot every week. If another client already
  // holds it, offer the waitlist instead of silently letting this one collide.
  const { data: slotTakenBy } = await db.from('recurring_schedules')
    .select('id, client_id, clients(full_name)').eq('day_of_week', day_of_week).eq('time_slot', time_slot)
    .eq('therapist_name', therapist_name).eq('status', 'active').neq('client_id', client.id).maybeSingle();
  if (slotTakenBy) {
    return res.status(409).json({
      error: `${therapist_name}'s ${WEEKDAY_NAMES[day_of_week]} ${time_slot} slot is already assigned to another client. Add ${client.full_name} to the waitlist instead, or pick a different time.`,
      slotTaken: true
    });
  }

  // General shift check: does this therapist actually work that weekday/hour
  // at all, checked against the next real occurrence of it. Booking-time
  // conflicts (a specific date already taken) are the guardian's own
  // self-booking's problem to catch, same as any other booking.
  const previewDate = (() => {
    const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() !== day_of_week) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const previewSlots = await slotInfoForDate(previewDate, therapist_name, sessionType);
  const previewSlot = previewSlots.find(s => s.time_slot === time_slot);
  if (!previewSlot) return res.status(400).json({ error: `${therapist_name} is not on shift ${WEEKDAY_NAMES[day_of_week]}s at ${time_slot}.` });
  if (previewSlot.lunch_break) return res.status(400).json({ error: `${therapist_name} is on their lunch break ${WEEKDAY_NAMES[day_of_week]}s at ${time_slot}.` });

  const { data: schedule, error: schedErr } = await db.from('recurring_schedules').insert({
    client_id: client.id, discipline, day_of_week, time_slot, therapist_name,
    status: 'active', created_by: req.user.id
  }).select().single();
  if (schedErr) return res.status(500).json({ error: schedErr.message });

  // A schedule IS this client's intake outcome for that discipline, so it
  // drives the same client-record fields the rest of the app already reads
  // (GAS pages' "Assigned Therapist", the guardian's own session-type picker,
  // the client directory's therapy-type badge), same as the old manual Edit
  // Client flow, just set here instead of by hand. A second discipline being
  // scheduled later (Combined) upgrades therapy_type to 'Both' rather than
  // overwriting the first.
  const clientPatch = {};
  if (discipline === 'OT') clientPatch.assigned_ot_therapist_name = therapist_name;
  else clientPatch.assigned_speech_therapist_name = therapist_name;
  if (!client.therapy_type) clientPatch.therapy_type = discipline;
  else if (client.therapy_type !== discipline && client.therapy_type !== 'Both') clientPatch.therapy_type = 'Both';
  await db.from('clients').update(clientPatch).eq('id', client.id);

  await logAudit({
    table_name: 'recurring_schedules', record_id: schedule.id, action: 'create',
    description: `Assigned ${sessionType} schedule for ${client.full_name}: ${WEEKDAY_NAMES[day_of_week]}s at ${time_slot} with ${therapist_name}`,
    created_by: req.user.id
  });

  if (client.parent_id) {
    await notifyEvent(null, {
      title: 'Therapy schedule assigned',
      body: `${client.full_name}'s ${sessionType} sessions are now fixed to ${WEEKDAY_NAMES[day_of_week]}s at ${time_slot} with ${therapist_name}. Book your sessions from the Booking page.`,
      icon: 'fa-calendar-check',
      target_user: client.parent_id
    });
  }

  res.status(201).json({ schedule });
});

/**
 * GET /api/reservations/:clientId/schedules, every recurring schedule (active,
 * awaiting re-evaluation, or discharged) for one client, each with its own
 * reservations so the UI can show "3 of 5 completed" without a second round trip.
 * Staff/admin see any client, a parent only their own child's.
 */
router.get('/:clientId/schedules', async (req, res) => {
  const { data: client } = await db.from('clients').select('id, parent_id').eq('id', req.params.clientId).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (req.user.role === 'parent' && client.parent_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your child record' });
  }

  const { data: schedules, error } = await db.from('recurring_schedules')
    .select('*').eq('client_id', client.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  for (const schedule of schedules || []) {
    const { data: sessions } = await db.from('reservations')
      .select('id, date, time_slot, status')
      .eq('recurring_schedule_id', schedule.id)
      .order('date', { ascending: true });
    schedule.reservations = sessions || [];
  }

  res.json(schedules || []);
});

/**
 * PUT /api/reservations/recurring-schedules/:id, admin/staff only. Ends a
 * client's fixed weekly schedule for a discipline, staff's own call whenever
 * the family says they're not continuing (there's no session count to run
 * out anymore, an active schedule just stays active indefinitely otherwise).
 * Doesn't touch any reservations already booked against it, those stand.
 */
router.put('/recurring-schedules/:id', requireRole('admin', 'staff'), async (req, res) => {
  if (req.body?.status !== 'discharged') {
    return res.status(400).json({ error: 'status must be "discharged"' });
  }
  const { data: schedule } = await db.from('recurring_schedules').select('id, client_id, discipline, day_of_week, time_slot, therapist_name, status').eq('id', req.params.id).maybeSingle();
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (schedule.status !== 'active') {
    return res.status(400).json({ error: 'Only an active schedule can be discharged.' });
  }

  const { schedule: data, notifiedWaitlistClient } = await dischargeSchedule(schedule, req.user.id, { reason: 'manual' });
  res.json({ ...data, notifiedWaitlistClient });
});

/**
 * POST /api/reservations/schedule-waitlist, admin/staff only. Queues a client
 * for a specific day/time/therapist slot that's already taken by someone
 * else's active schedule (see the slotTaken conflict on assign-schedule).
 */
router.post('/schedule-waitlist', requireRole('admin', 'staff'), async (req, res) => {
  const b = req.body || {};
  const { discipline, day_of_week, time_slot, therapist_name, client_id } = b;
  if (!discipline || !['OT', 'Speech'].includes(discipline)) return res.status(400).json({ error: 'discipline must be "OT" or "Speech"' });
  if (!Number.isInteger(day_of_week) || day_of_week < 0 || day_of_week > 6) return res.status(400).json({ error: 'day_of_week must be 0 through 6' });
  if (!time_slot) return res.status(400).json({ error: 'time_slot is required' });
  if (!therapist_name) return res.status(400).json({ error: 'therapist_name is required' });
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });

  const { data: client } = await db.from('clients').select('id, full_name').eq('id', client_id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { data: existing } = await db.from('schedule_waitlist').select('id')
    .eq('client_id', client_id).eq('day_of_week', day_of_week).eq('time_slot', time_slot).eq('therapist_name', therapist_name).eq('status', 'waiting').maybeSingle();
  if (existing) return res.status(409).json({ error: `${client.full_name} is already on this waitlist.` });

  const { data, error } = await db.from('schedule_waitlist').insert({
    discipline, day_of_week, time_slot, therapist_name, client_id, created_by: req.user.id
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'schedule_waitlist', record_id: data.id, action: 'create',
    description: `${client.full_name} added to the waitlist for ${WEEKDAY_NAMES[day_of_week]} ${time_slot} with ${therapist_name}`,
    created_by: req.user.id
  });

  res.status(201).json(data);
});

/** GET /api/reservations/schedule-waitlist?day_of_week=&time_slot=&therapist_name=, current FIFO order for one slot. */
router.get('/schedule-waitlist', requireRole('admin', 'staff'), async (req, res) => {
  const { day_of_week, time_slot, therapist_name } = req.query;
  let q = db.from('schedule_waitlist').select('*, clients(full_name, client_code)').eq('status', 'waiting').order('created_at', { ascending: true });
  if (day_of_week !== undefined) q = q.eq('day_of_week', Number(day_of_week));
  if (time_slot) q = q.eq('time_slot', time_slot);
  if (therapist_name) q = q.eq('therapist_name', therapist_name);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/** DELETE /api/reservations/schedule-waitlist/:id, admin/staff only, removes a client from a waitlist. */
router.delete('/schedule-waitlist/:id', requireRole('admin', 'staff'), async (req, res) => {
  const { data: entry } = await db.from('schedule_waitlist').select('id, client_id, clients(full_name)').eq('id', req.params.id).maybeSingle();
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  const { error } = await db.from('schedule_waitlist').update({ status: 'cancelled' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await logAudit({
    table_name: 'schedule_waitlist', record_id: req.params.id, action: 'delete',
    description: `${entry.clients?.full_name || 'Client'} removed from waitlist`, updated_by: req.user.id
  });
  res.json({ ok: true });
});

export default router;

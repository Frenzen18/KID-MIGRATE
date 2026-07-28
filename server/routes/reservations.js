import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getTherapistShifts, getAdminStaffShifts, hourLabel, labelToHour, worksOn, isLunchHour, workDayIndex } from './shifts.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent, therapistUserId } from '../lib/notify.js';
import { rateFor, genInvoiceNo } from '../lib/billing.js';
import { applyNoShowSideEffects, applyCancelSideEffects, releaseSessionPaymentAsCredit } from '../lib/noShow.js';
import { dischargeSchedule, notifyWaitlistForFreedSlot, notifyWaitlistEntry, assignWaitlistEntry } from '../lib/recurringSchedules.js';

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
 * A client can have more than one active schedule per discipline (policy: 1
 * session per therapist per week, so 2x/week needs 2 different therapists),
 * so unlike assignedTherapistFor's single clients.assigned_*_therapist_name
 * column, this returns ALL of them, the real source of truth for "who is
 * this client's OT/Speech therapist" whenever more than one is possible.
 */
async function activeScheduleTherapistNames(clientId, sessionType) {
  const d = disciplineOfSessionType(sessionType);
  if (!d) return [];
  const { data } = await db.from('recurring_schedules')
    .select('therapist_name').eq('client_id', clientId).eq('status', 'active')
    .eq('discipline', d === 'ot' ? 'OT' : 'Speech');
  return [...new Set((data || []).map(s => s.therapist_name))];
}

/**
 * A make-up session exists to catch up a specific missed occurrence, so one
 * should only be bookable when there's an actual unresolved cancellation or
 * no-show on file, never as a free-floating "extra session". A cancellation
 * counts as unresolved only if that exact date's slot with that therapist was
 * never re-filled afterward (e.g. cancelled then immediately rebooked at the
 * same date/time to fix a mistake isn't a real gap). Returns the distinct
 * therapist names with at least one such unresolved miss.
 */
async function outstandingMakeupTherapists(clientId, sessionType) {
  const { data } = await db.from('reservations')
    .select('id, date, therapist_name, status, is_makeup, created_at').eq('client_id', clientId).eq('session_type', sessionType);
  const all = data || [];
  // Scoped to THIS week only, not any week, or a client could pre-emptively
  // cancel a session weeks ahead of time and use that cancellation to justify
  // an extra make-up session right now, before the original session was even
  // supposed to happen, manufacturing sessions on demand instead of only
  // catching up a real, already-due miss. Resets every Monday.
  const { weekStart, weekEnd } = currentWeekRangePH();
  const inWeek = (dateStr) => dateStr >= weekStart && dateStr <= weekEnd;
  // PH-local calendar date a timestamp falls on, same +8h convention as todayPH().
  const phDateOf = (iso) => new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // A real miss: an actual (non-make-up) cancellation/no-show dated this
  // week, excluding one immediately corrected by a same-day/same-therapist
  // rebooking (that's a reschedule dance, not a genuine miss).
  const misses = all.filter(r => !r.is_makeup && ['cancelled', 'no_show'].includes(r.status) && r.therapist_name && inWeek(r.date)
    && !all.some(other => other.id !== r.id && other.therapist_name === r.therapist_name
      && other.date === r.date && !['cancelled', 'declined'].includes(other.status)));
  const missCounts = {};
  for (const m of misses) missCounts[m.therapist_name] = (missCounts[m.therapist_name] || 0) + 1;

  // Each make-up BOOKED this week spends one of this week's entitlements,
  // permanently, regardless of what its own session date is or what later
  // happens to it (completed, cancelled, no-showed). Without this, cancelling
  // a make-up would look exactly like a fresh miss and mint another make-up,
  // looping forever; and a client could otherwise use one real miss to book
  // an unlimited number of make-ups.
  const usedCounts = {};
  for (const r of all) {
    if (r.is_makeup && r.status !== 'declined' && r.therapist_name && r.created_at && inWeek(phDateOf(r.created_at))) {
      usedCounts[r.therapist_name] = (usedCounts[r.therapist_name] || 0) + 1;
    }
  }

  return Object.keys(missCounts).filter(name => missCounts[name] > (usedCounts[name] || 0));
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
  // automatically instead of billing it fresh. Matched by amount (there's no
  // discipline column on payments), which is really matching by discipline
  // since OT/Speech/Combined each have their own fixed rate (see rateFor) - a
  // Combined client's OT credit must never silently settle a Speech invoice
  // (or vice versa) at the wrong price, so a credit that doesn't match this
  // session's own rate is left untouched and a fresh invoice is billed instead.
  const sessionRate = await rateFor(reservation.session_type);
  const { data: credit } = await db.from('payments').select('*')
    .eq('client_id', reservation.client_id).eq('fee_type', 'session').eq('status', 'paid')
    .eq('amount', sessionRate)
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

  const amount = Number.isFinite(opts.amount) && opts.amount > 0 ? opts.amount : sessionRate;
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
 * rule as before). It IS gated on admin/staff shifts though, an Initial
 * Assessment needs an admin/staff person on hand to walk the family through
 * the facility, so an hour with no admin/staff on shift (or all of them at
 * lunch) isn't offered, even if it falls within clinic operating hours.
 */
async function slotInfoForDate(date, restrictToTherapist, serviceType) {
  if (await isClinicHoliday(date)) return [];
  // A client can have more than one active schedule (and therapist) for the
  // same discipline, so callers may pass an array of names to restrict to
  // instead of a single one, see activeScheduleTherapistNames.
  const restrictNames = restrictToTherapist ? (Array.isArray(restrictToTherapist) ? restrictToTherapist : [restrictToTherapist]) : null;

  if (CLINIC_WIDE_ASSESSMENT_TYPES.includes(serviceType)) {
    const hours = await getClinicHours(date);
    if (!hours) return [];
    const { data: active, error } = await db.from('reservations')
      .select('*, clients(full_name, client_code), payments(status, fee_type)')
      .eq('date', date).in('session_type', CLINIC_WIDE_ASSESSMENT_TYPES)
      .not('status', 'in', '(cancelled,declined)');
    if (error) throw new Error(error.message);

    // Clinic hours alone don't know about lunch, that's a per-therapist-shift
    // setting, an hour only actually has nobody free for intake when every
    // therapist on shift that hour is at lunch (an hour with no shift covering
    // it at all is left bookable, same clinic-wide-not-shift-dependent
    // reasoning as the rest of this branch).
    const shiftsAll = (await getTherapistShifts()).filter(s => worksOn(s, date));

    // Unlike therapist shifts above, admin/staff coverage actually gates the
    // hour outright: no admin/staff on shift (or all on lunch) means nobody's
    // free to walk the family through the facility, so the hour isn't offered
    // at all, not just left uncapped.
    const adminShiftsAll = (await getAdminStaffShifts()).filter(s => worksOn(s, date));

    const slots = [];
    for (let h = hours.start; h < hours.end; h++) {
      const booked = (active || []).filter(r => labelToHour(r.time_slot) === h);
      const onShift = shiftsAll.filter(s => s.start_hour <= h && h < s.end_hour);
      const lunchBreak = onShift.length > 0 && onShift.every(s => isLunchHour(s, h));
      const adminOnShift = adminShiftsAll.filter(s => s.start_hour <= h && h < s.end_hour);
      const noAdminAvailable = adminOnShift.length === 0 || adminOnShift.every(s => isLunchHour(s, h));
      const blocked = lunchBreak || noAdminAvailable;
      slots.push({
        time_slot: hourLabel(h),
        hour: h,
        capacity: 1,
        booked: booked.length,
        available: blocked ? 0 : Math.max(0, 1 - booked.length),
        therapists: [],
        lunch_break: lunchBreak,
        lunch_therapists: lunchBreak ? onShift.map(s => s.name) : [],
        no_admin_available: noAdminAvailable,
        reservations: booked,
        reservation: booked[0] || null
      });
    }
    return slots;
  }

  // Only therapists working on this weekday contribute capacity
  // (availability matrix: work_days Mon–Sat; Sundays the clinic is closed).
  let shifts = (await getTherapistShifts()).filter(s => worksOn(s, date));
  if (restrictNames) shifts = shifts.filter(s => restrictNames.includes(s.name));
  if (!shifts.length) return [];

  const { data: active, error } = await db.from('reservations')
    .select('*, clients(full_name, client_code), payments(status, fee_type)')
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
      && (!restrictNames || restrictNames.includes(r.therapist_name)));
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

/** Monday-Sunday bounds (inclusive) of the current PH-time calendar week, as
 *  "YYYY-MM-DD" strings. Used to scope make-up-session eligibility to only
 *  this week's cancellations, see outstandingMakeupTherapists. */
function currentWeekRangePH() {
  const d = new Date(todayPH() + 'T00:00:00Z');
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  return { weekStart: monday.toISOString().slice(0, 10), weekEnd: sunday.toISOString().slice(0, 10) };
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
  let q = db.from('reservations').select('*, clients(full_name, client_code, guardian_name, guardian_phone), payments(id, amount, status, method, invoice_no, paid_at, fee_type)').order('date').order('time_slot');
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
        // A client can have more than one active schedule for this discipline
        // (2x/week needs 2 different therapists), so scope by ALL of them, not
        // just clients.assigned_*_therapist_name, that column can only ever
        // hold one name and would silently hide the other therapist's slots.
        const scheduleNames = await activeScheduleTherapistNames(req.query.client_id, fallbackType);
        restrictToTherapist = scheduleNames.length ? scheduleNames : assignedTherapistFor(client, fallbackType);
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

  // A no-show or retainer fee is a penalty charge, not just a regular
  // invoice lagging behind (which is normal, a session invoice defaults to
  // Unpaid until staff records payment separately, and never blocks
  // anything on its own). While either is still outstanding, NO new booking
  // is allowed for this client - not even by staff, a hard block with no
  // override - the family must settle it (or staff waive it from Payments)
  // before booking resumes. Only blocks creating a brand new reservation,
  // already-booked future sessions are completely unaffected and can still
  // be rescheduled/cancelled/managed normally.
  // Exempt for a make-up session: the miss that likely created this very
  // fee also opened a make-up entitlement that expires at the end of the
  // week (see outstandingMakeupTherapists below), so blocking the make-up
  // itself until the fee is paid would let the family's catch-up window
  // quietly expire over an unrelated billing dispute, defeating the whole
  // point of a make-up.
  if (b.is_makeup !== true) {
    const { data: outstandingFees } = await db.from('payments')
      .select('id').eq('client_id', b.client_id).in('fee_type', ['no_show_fee', 'retainer_fee']).in('status', ['pending', 'overdue']).limit(1);
    if (outstandingFees?.length) {
      return res.status(403).json({
        error: `${bookingClient.full_name} has an unpaid no-show/retainer fee. Please settle it (or have staff waive it) before booking a new session.`
      });
    }
  }

  // Initial Assessment has no recurring schedule to scope an absence check to
  // (that's the OT/Speech-specific, excused-aware version further below), so
  // it keeps this simpler client-wide version: a parent can't self-book
  // another Initial Assessment for a child whose last 3 completed-or-no-show
  // assessment attempts were all no-shows, one real attendance resets it.
  // Staff/admin are exempt, this is deliberately only a self-service gate.
  if (req.user.role === 'parent' && b.session_type === 'Initial Assessment') {
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

  // Make-up session: a one-off addition booked into whatever open gap the
  // client's OWN assigned therapist happens to have, deliberately NOT
  // restricted to the client's fixed day/time (that's the whole point, e.g.
  // filling the gap a cancellation just freed up, see notifyEvent's own
  // "slot open for a make-up session" flag in noShow.js). Staff/admin only,
  // and always with the client's actual assigned therapist for that
  // discipline, never a substitute, otherwise it isn't really a make-up.
  const isMakeup = b.is_makeup === true;
  // The specific therapist this make-up is actually with, set once validated
  // below, never guessed from whatever day/time happens to be picked (see
  // makeupScheduleId further down, this is the fix for make-ups getting
  // silently tagged to an unrelated schedule that coincidentally shares a
  // day/time).
  let makeupTherapist = null;
  if (isMakeup) {
    if (!isStaff) return res.status(403).json({ error: 'Only staff/admin can book a make-up session.' });
    if (b.session_type !== 'Occupational Therapy' && b.session_type !== 'Speech Therapy') {
      return res.status(400).json({ error: 'Make-up sessions are only for Occupational or Speech Therapy, not assessments.' });
    }
    // A client can have 2 active schedules for the same discipline (2x/week,
    // 2 different therapists), so there isn't always a single "the" assigned
    // therapist, if there's more than one, staff must say which one this
    // make-up session is with rather than silently guessing.
    const makeupTherapistNames = await activeScheduleTherapistNames(b.client_id, b.session_type);
    if (!makeupTherapistNames.length) {
      return res.status(400).json({ error: `${bookingClient.full_name} doesn't have an assigned therapist for ${b.session_type} yet.` });
    }
    // No make-up without an actual unresolved miss to catch up, otherwise
    // it's just a regular extra session wearing a make-up label.
    const outstandingNames = (await outstandingMakeupTherapists(b.client_id, b.session_type)).filter(n => makeupTherapistNames.includes(n));
    if (!outstandingNames.length) {
      return res.status(400).json({ error: `${bookingClient.full_name} has no missed ${b.session_type} session on file, there's nothing to make up.` });
    }
    if (b.therapist_name) {
      if (!makeupTherapistNames.includes(b.therapist_name)) {
        return res.status(400).json({ error: `A make-up session must be with one of ${bookingClient.full_name}'s assigned therapists: ${makeupTherapistNames.join(', ')}.` });
      }
      if (!outstandingNames.includes(b.therapist_name)) {
        return res.status(400).json({ error: `${b.therapist_name} doesn't have a missed session on file for ${bookingClient.full_name} to make up.` });
      }
    } else if (outstandingNames.length > 1) {
      return res.status(400).json({ error: `${bookingClient.full_name} has more than one missed session (${outstandingNames.join(', ')}), specify which one this make-up session is with.` });
    }
    makeupTherapist = b.therapist_name || outstandingNames[0];
  }

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
  // Which recurring schedule a make-up session actually belongs to, matched
  // by THERAPIST (the schedule it's catching up for), never by day/time - a
  // make-up is deliberately booked outside its fixed day/time, so matching by
  // day/time (like lockedSchedule does for a regular booking) could silently
  // tag it to a completely unrelated schedule that just happens to share a
  // slot, double-counting someone else's absence streak/completed-session
  // tally and blocking the parent from cancelling their own make-up.
  let makeupScheduleId = null;
  if (b.session_type === 'Occupational Therapy' || b.session_type === 'Speech Therapy') {
    const scheduleDiscipline = b.session_type === 'Occupational Therapy' ? 'OT' : 'Speech';
    const { data: activeSchedules } = await db.from('recurring_schedules')
      .select('id, day_of_week, time_slot, therapist_name')
      .eq('client_id', b.client_id).eq('discipline', scheduleDiscipline).eq('status', 'active');
    if (isMakeup) {
      makeupScheduleId = (activeSchedules || []).find(s => s.therapist_name === makeupTherapist)?.id || null;
    }
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
      // Per the clinic's MOA, 3 consecutive UNEXCUSED absences on THIS
      // specific schedule flags it for staff review (see
      // checkConsecutiveAbsences in lib/noShow.js), a parent can't self-book
      // further into it while that's pending. Scoped to this exact
      // schedule/therapist, not the whole client, so a miss with one
      // therapist never blocks booking a different one, and it only fires on
      // unexcused streaks - 3 consecutive EXCUSED absences just means a
      // retainer fee, the slot isn't at risk, so booking (and paying) still
      // proceeds normally.
      // Excludes make-ups (booked on a different day by design, they'd
      // otherwise get mistaken for one of this schedule's own weekly misses)
      // and requires the 3 most recent to actually be consecutive weekly
      // occurrences (exactly 7 days apart) - a week the family never booked
      // at all leaves no row, and silently skipping past that gap would let
      // non-consecutive absences masquerade as a real 3-in-a-row streak.
      // Also capped to this week or earlier (a session cancelled far ahead of
      // time hasn't actually been missed yet) and includes a past
      // confirmed/rescheduled row so an attended-but-never-explicitly-resolved
      // session still breaks the streak instead of being silently invisible
      // to it - see checkConsecutiveAbsences in lib/noShow.js for the
      // identical, authoritative logic this mirrors.
      const { weekEnd: absenceWeekEnd } = currentWeekRangePH();
      const { data: recentOutcomes } = await db.from('reservations')
        .select('status, no_show_excused, date')
        .eq('recurring_schedule_id', lockedSchedule.id)
        .eq('is_makeup', false)
        .in('status', ['completed', 'no_show', 'cancelled', 'confirmed', 'rescheduled'])
        .lte('date', absenceWeekEnd)
        .order('date', { ascending: false })
        .limit(3);
      const rows3 = recentOutcomes || [];
      const isConsecutive = rows3.length === 3 && rows3.every((r, i) =>
        i === 0 || Math.round((Date.parse(rows3[i - 1].date) - Date.parse(r.date)) / 86400000) === 7);
      const recentAbsences = rows3.filter(r => r.status === 'no_show' || r.status === 'cancelled');
      if (isConsecutive && recentAbsences.length === 3 && recentAbsences.every(r => r.no_show_excused === false)) {
        return res.status(403).json({
          error: `${bookingClient.full_name}'s ${b.session_type} slot (${WEEKDAY_NAMES[lockedSchedule.day_of_week]}s at ${lockedSchedule.time_slot}) has 3 consecutive unexcused absences and is under staff review. Please contact the clinic directly to resume booking.`
        });
      }
    } else {
      const bookingWeekday = new Date(b.date + 'T00:00:00Z').getUTCDay();
      lockedSchedule = (activeSchedules || []).find(s => s.day_of_week === bookingWeekday && s.time_slot === b.time_slot) || null;
      // Staff/admin used to be able to book a client with a fixed schedule
      // into ANY open day/time for a regular (non-make-up) session, "they
      // might be fixing a one-off scheduling issue" was the original reasoning,
      // but that's now exactly what make-up sessions exist for, with real
      // validation (an actual missed session this week, matching therapist).
      // Leaving this open would let staff route around every one of those
      // rules just by not checking the make-up box, so a client who already
      // has an active schedule is now locked to it here too, same as a
      // guardian's own self-booking. Exempt only for a make-up (its whole
      // point is an open gap outside the fixed day/time) or a client with no
      // active schedule for this discipline yet (nothing to lock to).
      if (!isMakeup && activeSchedules?.length && !lockedSchedule) {
        const options = activeSchedules.map(s => `${WEEKDAY_NAMES[s.day_of_week]}s at ${s.time_slot} with ${s.therapist_name}`).join('; ');
        return res.status(400).json({
          error: `${bookingClient.full_name}'s ${b.session_type} schedule is fixed to: ${options}. Book one of those day/times, or check "This is a make-up session" to book outside it.`
        });
      }
    }
  }
  const assignedTherapist = assignedTherapistFor(bookingClient, b.session_type);
  // A make-up session always goes to the exact therapist validated above,
  // never a coincidental day/time match. An explicit staff selection (e.g.
  // overriding who a slot goes to) always wins otherwise, staff isn't bound
  // by any schedule lock. Absent that, a guardian's locked-schedule booking
  // uses that exact schedule's own therapist (a discipline can have more than
  // one, different day/times, so the single assigned_*_therapist_name field
  // alone can't be trusted here), otherwise falls back to the client's
  // Assigned Therapist.
  const requestedTherapist = isMakeup ? makeupTherapist
    : (isStaff && b.therapist_name) ? b.therapist_name : lockedSchedule ? lockedSchedule.therapist_name : assignedTherapist;

  // With no specific therapist requested (new client, no schedule yet, staff
  // didn't pick one), the slot lookup must still be scoped to the session's
  // own discipline, or assignTherapist's random-pick fallback below could
  // hand a Speech Therapy session to an on-shift OT therapist (and vice
  // versa) since getTherapistShifts() returns both roles combined.
  const bookingDiscipline = disciplineOfSessionType(b.session_type);
  let slotRestriction = requestedTherapist;
  if (!slotRestriction && bookingDiscipline) {
    const disciplineShifts = await getTherapistShifts();
    slotRestriction = disciplineShifts.filter(s => s.role === bookingDiscipline).map(s => s.name);
  }
  const slots = await slotInfoForDate(b.date, slotRestriction, b.session_type);
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

  // Initial Assessment additionally needs admin/staff on shift to walk the
  // family through the facility, checked explicitly same as the lunch break
  // above, in case the front end's slot list is stale.
  if (CLINIC_WIDE_ASSESSMENT_TYPES.includes(b.session_type) && slot.no_admin_available) {
    return res.status(409).json({ error: 'No front-desk staff are on shift at that time, please pick a different slot.' });
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
  // is only a REAL conflict if it's also the same THERAPIST, one person can't
  // see two kids at once. Different therapists (e.g. each sibling has their
  // own pinned recurring-schedule therapist) can each see their own kid at
  // the same hour just fine, same reasoning different disciplines already
  // got: the resource that's actually scarce is the therapist, not "a slot".
  if (bookingClient.parent_id && newDiscipline && requestedTherapist) {
    const { data: siblingClients } = await db.from('clients').select('id, full_name').eq('parent_id', bookingClient.parent_id).neq('id', b.client_id);
    const siblingIds = (siblingClients || []).map(c => c.id);
    if (siblingIds.length) {
      const { data: siblingSameSlot } = await db.from('reservations')
        .select('id, client_id, session_type, therapist_name')
        .in('client_id', siblingIds)
        .eq('date', b.date)
        .eq('time_slot', b.time_slot)
        .not('status', 'in', '(cancelled,declined)');
      const siblingConflict = (siblingSameSlot || []).find(r => disciplineOfSessionType(r.session_type) === newDiscipline && r.therapist_name === requestedTherapist);
      if (siblingConflict) {
        const conflictChild = siblingClients.find(c => c.id === siblingConflict.client_id);
        return res.status(409).json({ error: `${conflictChild?.full_name || 'Another one of your children'} already has a session with ${requestedTherapist} at ${b.time_slot} on ${b.date}. Please pick a different time for ${bookingClient.full_name}.` });
      }
    }
  }

  // The "only one booking per day" rule exists to stop an ad-hoc/one-off
  // booking from silently duplicating (same reasoning as the exact-time check
  // above, just widened to the whole day). It does NOT apply to a locked
  // recurring-schedule booking: a client legitimately recommended for more
  // than one weekly session (1 therapist per week policy, so 2x/week needs 2
  // different therapists) can have both of those pinned slots fall on the
  // SAME calendar day by design (see assign-schedule's own day/time
  // collision check, which only blocks an EXACT day+time clash, not merely
  // sharing a day), the exact-time check above already guards the real conflict.
  // A make-up session is exempt too, the whole point is catching up a missed
  // session on a day the client already has (or had) a regular one, the
  // isMakeup validation above already confines it to the client's own
  // assigned therapist, that's the only restriction that should apply.
  const sameDayConflict = (lockedSchedule || isMakeup)
    ? false
    : (bookingClient.therapy_type === 'Both' && newDiscipline)
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

  // Every discipline-bound session type must go to a therapist of the
  // matching role, this only fires when a specific therapist was actually
  // requested, see the slotInfoForDate call above for the OTHER half of this:
  // when nothing was requested, the slot lookup itself is already scoped to
  // the right role so assignTherapist's random-pick fallback can't cross into
  // the wrong discipline.
  const requiredRole = disciplineOfSessionType(b.session_type);
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
    recurring_schedule_id: isMakeup ? makeupScheduleId : (lockedSchedule?.id || null),
    is_makeup: isMakeup
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
      // A make-up session is the one exception: it's catching up a session
      // the client already paid for (or didn't), so it should NOT be
      // auto-marked paid just because staff booked it in person, only an
      // unresolved credit (handled inside ensurePaymentForReservation) or an
      // explicit method choice should ever mark it paid.
      const amt = Number(b.payment_amount);
      payment = await ensurePaymentForReservation(data, req.user.id, {
        amount: Number.isFinite(amt) ? amt : undefined,
        method: b.payment_method || (isMakeup ? undefined : 'Cash')
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

  // The guardian to notify about this reservation's outcome is the client's
  // actual parent_id, NOT existing.created_by - a session generated by staff
  // (assigning a recurring schedule, or any other staff booking) has
  // created_by set to whichever staff/admin made that API call, not the
  // family, so notifying created_by would alert the wrong person for the
  // majority of a client's ongoing scheduled sessions.
  const { data: existingClient } = await db.from('clients').select('parent_id').eq('id', existing.client_id).maybeSingle();
  const guardianId = existingClient?.parent_id || null;

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
    // Covers every discipline-bound type (Occupational/Speech Therapy, not
    // just the retired discipline-specific assessments SESSION_TYPE_ROLE was
    // originally scoped to), a direct therapist reassignment must always land
    // on someone of the matching role, regardless of session type.
    const requiredRole = disciplineOfSessionType(existing.session_type);
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
    const { data: reschedClient } = await db.from('clients')
      .select('parent_id, assigned_ot_therapist_name, assigned_speech_therapist_name, therapy_type')
      .eq('id', existing.client_id).maybeSingle();
    const assignedTherapist = assignedTherapistFor(reschedClient || {}, existing.session_type);
    const existingDiscipline = disciplineOfSessionType(existing.session_type);

    // A session tied to a fixed recurring schedule can only be rescheduled to
    // a different WEEK's occurrence of that exact SAME schedule, same
    // day-of-week, same time, same therapist, never a different one, even if
    // the client has another active schedule for this discipline (2x/week
    // needs 2 different therapists, but each is its own fixed commitment, not
    // interchangeable with the other). Moving it off that pattern entirely
    // would defeat the whole point of a fixed slot (the guardian would just
    // stack a fresh occurrence instead of rescheduling one). A make-up session
    // was never on the fixed schedule to begin with, it's exempt, same "any
    // open gap with the client's own assigned therapist" flexibility as
    // booking one.
    let matchedSchedule = null;
    if (existing.recurring_schedule_id && !existing.is_makeup) {
      const { data: homeSchedule } = await db.from('recurring_schedules')
        .select('id, day_of_week, time_slot, therapist_name, status').eq('id', existing.recurring_schedule_id).maybeSingle();
      const newWeekday = new Date(b.date + 'T00:00:00Z').getUTCDay();
      const matches = homeSchedule && homeSchedule.status === 'active'
        && homeSchedule.day_of_week === newWeekday && homeSchedule.time_slot === b.time_slot;
      if (!matches) {
        return res.status(400).json({
          error: homeSchedule
            ? `This session is part of a fixed schedule (${WEEKDAY_NAMES[homeSchedule.day_of_week]}s at ${homeSchedule.time_slot} with ${homeSchedule.therapist_name}). It can only be rescheduled to a different week's occurrence of that same day/time, or book a make-up session instead for a one-off change.`
            : `This session's fixed schedule is no longer active. Book a make-up session instead for a one-off change.`
        });
      }
      matchedSchedule = homeSchedule;
    }
    // A locked-schedule reschedule follows that schedule's own pinned
    // therapist, authoritative over "keep the current therapist if free"
    // (which only applies to a non-schedule reschedule, e.g. a make-up).
    const scopeTherapist = matchedSchedule ? matchedSchedule.therapist_name : (existing.therapist_name || assignedTherapist);

    // A client can only have one active booking per day, same rule as new bookings,
    // with the same Combined-client exception (one OT + one Speech same day is fine).
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

    // Same sibling check as new bookings: only a real conflict if it's also
    // the SAME therapist (one person can't see two kids at once), a different
    // therapist for the same discipline can see the other sibling at that
    // same hour just fine.
    if (reschedClient?.parent_id && existingDiscipline && scopeTherapist) {
      const { data: siblingClients } = await db.from('clients').select('id, full_name').eq('parent_id', reschedClient.parent_id).neq('id', existing.client_id);
      const siblingIds = (siblingClients || []).map(c => c.id);
      if (siblingIds.length) {
        const { data: siblingSameSlot } = await db.from('reservations')
          .select('id, client_id, session_type, therapist_name')
          .in('client_id', siblingIds)
          .eq('date', b.date)
          .eq('time_slot', b.time_slot)
          .not('status', 'in', '(cancelled,declined)');
        const siblingConflict = (siblingSameSlot || []).find(r => disciplineOfSessionType(r.session_type) === existingDiscipline && r.therapist_name === scopeTherapist);
        if (siblingConflict) {
          const conflictChild = siblingClients.find(c => c.id === siblingConflict.client_id);
          return res.status(409).json({ error: `${conflictChild?.full_name || 'A sibling'} already has a session with ${scopeTherapist} at ${b.time_slot} on ${b.date}. Please pick a different time.` });
        }
      }
    }

    // Same "not for a locked recurring schedule" exemption as new bookings:
    // a client recommended for more than one weekly session (2 different
    // therapists) can legitimately have both pinned slots on the same day,
    // the exact-time check above already guards the real conflict.
    const sameDayConflict = existing.recurring_schedule_id
      ? false
      : (reschedClient?.therapy_type === 'Both' && existingDiscipline)
        ? (sameDayForChild || []).some(r => disciplineOfSessionType(r.session_type) === existingDiscipline)
        : (sameDayForChild || []).length > 0;
    if (sameDayConflict) {
      return res.status(409).json({ error: `This client already has a booking on ${b.date}.` });
    }

    // Same discipline-scoping as a new booking: with no specific therapist to
    // fall back to (e.g. an unassigned session being rescheduled), the slot
    // lookup must still stay within the right role, not the whole clinic.
    let rescheduleSlotRestriction = scopeTherapist;
    if (!rescheduleSlotRestriction && existingDiscipline) {
      const disciplineShifts = await getTherapistShifts();
      rescheduleSlotRestriction = disciplineShifts.filter(s => s.role === existingDiscipline).map(s => s.name);
    }
    const slots = await slotInfoForDate(b.date, rescheduleSlotRestriction, existing.session_type);
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
    // Same admin/staff coverage requirement as a new Initial Assessment booking.
    if (CLINIC_WIDE_ASSESSMENT_TYPES.includes(existing.session_type) && slot.no_admin_available) {
      return res.status(409).json({ error: 'No front-desk staff are on shift at that time, please pick a different slot.' });
    }
    // Ignore this reservation itself when counting the target slot's load.
    slot.reservations = slot.reservations.filter(r => r.id !== req.params.id);
    slot.available = Math.max(0, slot.capacity - slot.reservations.length);

    if (CLINIC_WIDE_ASSESSMENT_TYPES.includes(existing.session_type) && slot.reservations.some(r => CLINIC_WIDE_ASSESSMENT_TYPES.includes(r.session_type))) {
      return res.status(409).json({ error: `Only one ${existing.session_type} can be booked per hour.` });
    }
    if (slot.available <= 0) return res.status(409).json({ error: 'Target slot is fully booked' });

    // A locked-schedule reschedule always goes to that schedule's own pinned
    // therapist, no ambiguity there. Otherwise keep the same therapist if
    // they're free at the new time, else fall back to the client's Assigned
    // Therapist, else auto-assign, except an Initial Assessment, which stays
    // unassigned (same reasoning as new bookings above) rather than picking
    // someone at random just because it's moving times.
    const keep = !matchedSchedule && existing.therapist_name && slot.therapists.includes(existing.therapist_name)
      && !slot.reservations.some(r => r.therapist_name === existing.therapist_name);
    const assigned = matchedSchedule
      ? { therapist_name: matchedSchedule.therapist_name }
      : keep
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
    // Follow the schedule the new day/time actually matched, if it's a
    // different one than the session was originally on (e.g. moving between
    // a client's 2 weekly OT schedules), so per-schedule tracking like the
    // sessions_completed counter below credits the right one.
    if (matchedSchedule) patch.recurring_schedule_id = matchedSchedule.id;

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

  // markOverduePayments (reminders.js) only ever moves a payment forward,
  // pending -> overdue, once its reservation's date has passed, it never
  // checks back. A reschedule can move that same date into the future again
  // (e.g. staff pushes a missed session out a week), so without this the
  // invoice stays permanently stuck 'overdue' even though it's no longer
  // actually past its due date.
  if (patch.date && patch.date >= todayPH()) {
    await db.from('payments').update({ status: 'pending' }).eq('reservation_id', req.params.id).eq('status', 'overdue');
  }

  if (patch.status === 'confirmed') {
    await logAudit({
      table_name: 'reservations', record_id: req.params.id, action: 'approve',
      description: `Reservation confirmed for ${data.date} ${data.time_slot}`,
      approved_by: req.user.id
    });
    // Same make-up exception as new bookings: don't default to Cash/paid,
    // only an explicit method or an existing credit should mark it paid.
    const amt = Number(b.payment_amount);
    await ensurePaymentForReservation(data, req.user.id, {
      amount: Number.isFinite(amt) ? amt : undefined,
      method: b.payment_method || (data.is_makeup ? undefined : 'Cash')
    });
    if (guardianId) {
      await notifyEvent('notify_session_change', {
        title: 'Booking confirmed',
        body: `Your session on ${data.date} at ${data.time_slot} has been confirmed.`,
        icon: 'fa-calendar-check',
        target_user: guardianId
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

    // Keep attendance-rate reporting (parent portal, admin reports) in sync
    // with the booking outcome, mirrors the no-show path's own attendance
    // insert (see applyNoShowSideEffects) - without this, a completed session
    // never records an actual attendance, so the rate stays understated/zero
    // no matter how many sessions really happened.
    if (patch.status === 'completed' && existing.status !== 'completed') {
      await db.from('attendance').insert({ client_id: existing.client_id, session_date: existing.date, attended: true });
    }

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
      // No pending/unpaid invoice should ever survive a cancelled or declined
      // session, nothing was ever collected for it and it's not happening.
      // This applies regardless of the reservation's prior status: an
      // awaiting_payment hold never got its QRPh checkout finished, but a
      // CONFIRMED recurring/staff booking can just as easily still be sitting
      // on its default Unpaid invoice (see ensurePaymentForReservation) at
      // cancellation time, leaving that behind kept billing the guardian for
      // a session that's gone (this is what "duplicate" pending invoices for
      // the same day turned out to be, an orphaned one from an earlier
      // cancel that was never cleared).
      await db.from('payments').delete().eq('reservation_id', existing.id).eq('status', 'pending');
      if (patch.status === 'cancelled') {
        // A confirmed (already paid or billed) session being cancelled is, by
        // definition, for a legitimate reason, staff cancelling it on the
        // guardian's behalf, not the guardian's own pending request being
        // withdrawn. Releases any PAID invoice as a credit for their next
        // session, and counts toward the 3-consecutive-absence policy. Never
        // conflicts with the delete above, a paid invoice's own status isn't
        // 'pending' so it isn't touched by it.
        await applyCancelSideEffects(existing, req.user.id);
      }
      const verb = patch.status === 'cancelled' ? 'cancelled' : 'declined';
      if (guardianId && guardianId !== req.user.id) {
        // Staff/admin cancelled or declined a parent's booking, let the parent know.
        await notifyEvent('notify_session_cancellation', {
          title: `Booking ${verb}`,
          body: `Your session on ${existing.date} at ${existing.time_slot} was ${verb}${b.notes ? ': ' + b.notes : '.'}`,
          icon: 'fa-calendar-xmark',
          target_user: guardianId
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
      if (guardianId) {
        // Staff rescheduled an existing booking to a new date/time.
        await notifyEvent('notify_reschedule_request', {
          title: 'Session rescheduled',
          body: `Your session has been moved to ${data.date} at ${data.time_slot}.`,
          icon: 'fa-arrows-rotate',
          target_user: guardianId
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

  const today = todayPH();
  for (const schedule of schedules || []) {
    const { data: sessions } = await db.from('reservations')
      .select('id, date, time_slot, status, no_show_excused, is_makeup')
      .eq('recurring_schedule_id', schedule.id)
      .order('date', { ascending: true });
    schedule.reservations = sessions || [];
    // The stored counter only increments on an explicit "completed"
    // transition (PUT /:id), so a past session nobody ever resolved (still
    // 'confirmed'/'rescheduled' well after its date) understates it.
    // Recomputed live here to match what the calendar itself already
    // displays as effectively completed (see isEffectivelyCompleted
    // client-side) - a session dated before today is guaranteed to already be
    // past regardless of time-of-day, so no need for finer-grained time math.
    schedule.sessions_completed = schedule.reservations.filter(r =>
      r.status === 'completed' || (['confirmed', 'rescheduled'].includes(r.status) && r.date < today)
    ).length;
  }

  res.json(schedules || []);
});

/**
 * GET /api/reservations/recurring-schedules/taken?day_of_week=&therapist_name=,
 * admin/staff only. Which time_slots this therapist already has an ACTIVE
 * recurring schedule against (any client) on that weekday, so the Assign/Edit
 * Schedule form can gray those out up front, the same way the real booking
 * calendar grays out an already-booked time, instead of only failing after
 * "Assign"/"Save" is clicked. A schedule is a standing pin, not a booked
 * reservation, so this can't just reuse GET /reservations/slots (which only
 * sees actual booked dates), it has to check recurring_schedules directly.
 */
router.get('/recurring-schedules/taken', requireRole('admin', 'staff'), async (req, res) => {
  const day_of_week = Number(req.query.day_of_week);
  const therapist_name = req.query.therapist_name;
  if (!Number.isInteger(day_of_week) || day_of_week < 0 || day_of_week > 6) return res.status(400).json({ error: 'day_of_week must be 0 through 6' });
  if (!therapist_name) return res.status(400).json({ error: 'therapist_name is required' });

  let q = db.from('recurring_schedules').select('time_slot, client_id, clients(full_name)')
    .eq('day_of_week', day_of_week).eq('therapist_name', therapist_name).eq('status', 'active');
  if (req.query.exclude_schedule_id) q = q.neq('id', req.query.exclude_schedule_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  res.json((data || []).map(s => ({ time_slot: s.time_slot, client_name: s.clients?.full_name || null })));
});

/**
 * PUT /api/reservations/recurring-schedules/:id, admin/staff only.
 * `{ status: 'discharged' }` ends a client's fixed weekly schedule for a
 * discipline, staff's own call whenever the family says they're not
 * continuing (there's no session count to run out anymore, an active
 * schedule just stays active indefinitely otherwise). Doesn't touch any
 * reservations already booked against it, those stand.
 *
 * `{ day_of_week, time_slot, therapist_name }` instead EDITS an existing
 * active schedule in place (same re-validation as assigning a new one), so
 * fixing a mistake or moving a family to a different day/time doesn't mean
 * discharging and starting over, losing the sessions_completed count and
 * needlessly notifying the waitlist for what might just be a typo fix. If the
 * exact day/time/therapist combo actually changes, the OLD one really does
 * free up, so the waitlist for THAT combo is notified same as a discharge.
 */
router.put('/recurring-schedules/:id', requireRole('admin', 'staff'), async (req, res) => {
  const b = req.body || {};
  const { data: schedule } = await db.from('recurring_schedules').select('*').eq('id', req.params.id).maybeSingle();
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  if (b.status === 'discharged') {
    if (schedule.status !== 'active') return res.status(400).json({ error: 'Only an active schedule can be discharged.' });
    const { schedule: data, notifiedWaitlistClient, cancelledCount } = await dischargeSchedule(schedule, req.user.id, { reason: 'manual' });
    return res.json({ ...data, notifiedWaitlistClient, cancelledCount });
  }

  if (b.day_of_week === undefined && b.time_slot === undefined && b.therapist_name === undefined) {
    return res.status(400).json({ error: 'Provide day_of_week/time_slot/therapist_name to edit, or status: "discharged" to end it.' });
  }
  if (schedule.status !== 'active') return res.status(400).json({ error: 'Only an active schedule can be edited.' });

  const newDay = b.day_of_week !== undefined ? Number(b.day_of_week) : schedule.day_of_week;
  const newTime = b.time_slot || schedule.time_slot;
  const newTherapist = b.therapist_name || schedule.therapist_name;
  if (!Number.isInteger(newDay) || newDay < 0 || newDay > 6) return res.status(400).json({ error: 'day_of_week must be 0 through 6' });

  const { data: client } = await db.from('clients').select('id, full_name, parent_id').eq('id', schedule.client_id).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const requiredRole = schedule.discipline === 'OT' ? 'ot' : 'speech';
  const shiftsAll = await getTherapistShifts();
  const pickedTherapist = shiftsAll.find(s => s.name === newTherapist);
  if (!pickedTherapist || pickedTherapist.role !== requiredRole) {
    return res.status(400).json({ error: `${newTherapist} is not ${requiredRole === 'speech' ? 'a Speech-Language' : 'an Occupational'} therapist.` });
  }

  const { data: othersForClient } = await db.from('recurring_schedules')
    .select('id, therapist_name, day_of_week, time_slot').eq('client_id', client.id).eq('status', 'active').neq('id', schedule.id);
  if ((othersForClient || []).some(s => s.therapist_name === newTherapist)) {
    return res.status(409).json({ error: `${newTherapist} already has an active schedule with ${client.full_name}, one session per therapist per week.` });
  }
  if ((othersForClient || []).some(s => s.day_of_week === newDay && s.time_slot === newTime)) {
    return res.status(409).json({ error: `${client.full_name} already has a schedule ${WEEKDAY_NAMES[newDay]}s at ${newTime}.` });
  }

  const { data: slotTakenBy } = await db.from('recurring_schedules')
    .select('id, client_id, clients(full_name)').eq('day_of_week', newDay).eq('time_slot', newTime)
    .eq('therapist_name', newTherapist).eq('status', 'active').neq('id', schedule.id).neq('client_id', client.id).maybeSingle();
  if (slotTakenBy) {
    return res.status(409).json({
      error: `${newTherapist}'s ${WEEKDAY_NAMES[newDay]} ${newTime} slot is already assigned to another client. Add ${client.full_name} to the waitlist instead, or pick a different time.`,
      slotTaken: true
    });
  }

  const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const previewDate = (() => {
    const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    while (d.getUTCDay() !== newDay) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const previewSlots = await slotInfoForDate(previewDate, newTherapist, sessionType);
  const previewSlot = previewSlots.find(s => s.time_slot === newTime);
  if (!previewSlot) return res.status(400).json({ error: `${newTherapist} is not on shift ${WEEKDAY_NAMES[newDay]}s at ${newTime}.` });
  if (previewSlot.lunch_break) return res.status(400).json({ error: `${newTherapist} is on their lunch break ${WEEKDAY_NAMES[newDay]}s at ${newTime}.` });

  const changed = newDay !== schedule.day_of_week || newTime !== schedule.time_slot || newTherapist !== schedule.therapist_name;
  const { data: updated, error: updErr } = await db.from('recurring_schedules')
    .update({ day_of_week: newDay, time_slot: newTime, therapist_name: newTherapist }).eq('id', schedule.id).select().single();
  if (updErr) return res.status(500).json({ error: updErr.message });

  if (newTherapist !== schedule.therapist_name) {
    const clientPatch = schedule.discipline === 'OT' ? { assigned_ot_therapist_name: newTherapist } : { assigned_speech_therapist_name: newTherapist };
    await db.from('clients').update(clientPatch).eq('id', client.id);
  }

  await logAudit({
    table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
    description: `${sessionType} schedule for ${client.full_name} updated to ${WEEKDAY_NAMES[newDay]}s at ${newTime} with ${newTherapist}`,
    updated_by: req.user.id
  });

  let notifiedWaitlistClient = null;
  let reconciledCount = 0;
  if (changed) {
    // Any future reservation already booked under the OLD day/time/therapist
    // no longer matches what this schedule now represents. Left standing, it
    // becomes unmanageable (can't be rescheduled, the parent can't self-cancel
    // it, see the "schedule no longer active"-style guards elsewhere) and can
    // silently distort the 3-consecutive-absence math. Cancelled outright
    // instead - no_show_excused stays true and checkConsecutiveAbsences is
    // never invoked, this is an administrative schedule move, not a real
    // miss, it must never count as one - so staff/guardian can rebook fresh
    // under the corrected day/time.
    const { data: staleFuture } = await db.from('reservations')
      .select('*').eq('recurring_schedule_id', schedule.id)
      .in('status', ['confirmed', 'rescheduled', 'awaiting_payment'])
      .gt('date', todayPH());
    for (const r of staleFuture || []) {
      const matchesNewConfig = new Date(r.date + 'T00:00:00Z').getUTCDay() === newDay
        && r.time_slot === newTime && r.therapist_name === newTherapist;
      if (matchesNewConfig) continue;
      await db.from('payments').delete().eq('reservation_id', r.id).eq('status', 'pending');
      const credited = await releaseSessionPaymentAsCredit(r, 'Schedule updated');
      await db.from('reservations').update({ status: 'cancelled', no_show_excused: true }).eq('id', r.id);
      reconciledCount++;
      if (r.created_by) {
        await notifyEvent(null, {
          title: 'Session cancelled, schedule updated',
          body: `Your session on ${r.date} at ${r.time_slot} was cancelled because that fixed schedule moved to ${WEEKDAY_NAMES[newDay]}s at ${newTime} with ${newTherapist}.${credited ? ' Your payment for it will be applied to your next session.' : ''}`,
          icon: 'fa-circle-check',
          target_user: r.created_by
        });
      }
    }

    notifiedWaitlistClient = await notifyWaitlistForFreedSlot(schedule.discipline, schedule.day_of_week, schedule.time_slot, schedule.therapist_name);
    if (client.parent_id) {
      await notifyEvent(null, {
        title: 'Therapy schedule updated',
        body: `${client.full_name}'s ${sessionType} sessions are now fixed to ${WEEKDAY_NAMES[newDay]}s at ${newTime} with ${newTherapist}.${reconciledCount ? ` ${reconciledCount} previously-booked session(s) under the old day/time were cancelled and credited.` : ''}`,
        icon: 'fa-calendar-check',
        target_user: client.parent_id
      });
    }
  }

  res.json({ ...updated, notifiedWaitlistClient, reconciledCount });
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

/**
 * GET /api/reservations/schedule-waitlist?day_of_week=&time_slot=&therapist_name=&status=,
 * admin/staff see every client on the waitlist (any status, for the Waitlist
 * tab's overview); a parent sees only their own children's entries (so the
 * Booking page can show them any offer they've been notified about). Every
 * filter is optional, given none at all this returns the full list. Each
 * still-'waiting' row gets its live FIFO `queue_position` within its own
 * exact (day/time/therapist) group, so "1st in line" etc. never has to be
 * recomputed client-side from possibly-partial data.
 */
router.get('/schedule-waitlist', async (req, res) => {
  const { day_of_week, time_slot, therapist_name, status } = req.query;
  let q = db.from('schedule_waitlist').select('*, clients(full_name, client_code, parent_id)').order('created_at', { ascending: true });
  if (req.user.role === 'parent') {
    const { data: myClients } = await db.from('clients').select('id').eq('parent_id', req.user.id);
    const ids = (myClients || []).map(c => c.id);
    q = ids.length ? q.in('client_id', ids) : q.eq('id', '00000000-0000-0000-0000-000000000000');
  } else if (!['admin', 'staff'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  if (day_of_week !== undefined) q = q.eq('day_of_week', Number(day_of_week));
  if (time_slot) q = q.eq('time_slot', time_slot);
  if (therapist_name) q = q.eq('therapist_name', therapist_name);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const waitingByGroup = {};
  for (const row of data || []) {
    if (row.status !== 'waiting') continue;
    const key = row.day_of_week + '|' + row.time_slot + '|' + row.therapist_name;
    (waitingByGroup[key] ||= []).push(row);
  }
  for (const group of Object.values(waitingByGroup)) {
    group.forEach((row, i) => { row.queue_position = i + 1; }); // already created_at-ordered by the query above
  }

  // Each row also gets `slot_taken`, whether its exact day/time/therapist combo
  // currently has an active recurring schedule, so the Waitlist tab can gray
  // out Assign until the outgoing client (if any) has actually been discharged.
  const { data: activeSchedules } = await db.from('recurring_schedules')
    .select('day_of_week, time_slot, therapist_name').eq('status', 'active');
  const takenSlots = new Set((activeSchedules || []).map(s => s.day_of_week + '|' + s.time_slot + '|' + s.therapist_name));
  for (const row of data || []) {
    row.slot_taken = takenSlots.has(row.day_of_week + '|' + row.time_slot + '|' + row.therapist_name);
  }

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

/**
 * POST /api/reservations/schedule-waitlist/:id/notify, admin/staff only. Manually
 * offers this specific waitlist entry the slot (in-app + SMS + email, same
 * delivery as the automatic FIFO notify, see notifyWaitlistEntry), letting
 * staff notify a particular guardian directly instead of only ever offering
 * strict first-in-line order.
 */
router.post('/schedule-waitlist/:id/notify', requireRole('admin', 'staff'), async (req, res) => {
  const { data: entry } = await db.from('schedule_waitlist')
    .select('*, clients(full_name, parent_id, guardian_contact)').eq('id', req.params.id).maybeSingle();
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (entry.status !== 'waiting') return res.status(400).json({ error: `Only a waiting entry can be notified (status: ${entry.status}).` });

  const notifiedWaitlistClient = await notifyWaitlistEntry(entry);
  res.json({ ok: true, notifiedWaitlistClient });
});

/**
 * POST /api/reservations/schedule-waitlist/:id/assign, admin/staff only. Skips
 * the notify/accept round-trip and directly assigns this waitlisted client to
 * their slot, e.g. once the outgoing client has already been discharged and
 * staff would rather hand-assign than wait on a guardian's response. Re-checks
 * the slot is actually free first (see assignWaitlistEntry).
 */
router.post('/schedule-waitlist/:id/assign', requireRole('admin', 'staff'), async (req, res) => {
  const { data: entry } = await db.from('schedule_waitlist')
    .select('*, clients(id, full_name, parent_id, therapy_type, assigned_ot_therapist_name, assigned_speech_therapist_name)')
    .eq('id', req.params.id).maybeSingle();
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (!['waiting', 'notified'].includes(entry.status)) return res.status(400).json({ error: `This entry can no longer be assigned (status: ${entry.status}).` });
  if (!entry.clients) return res.status(404).json({ error: 'Client not found' });

  let result;
  try {
    result = await assignWaitlistEntry(entry, req.user.id);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  await logAudit({
    table_name: 'recurring_schedules', record_id: result.schedule.id, action: 'create',
    description: `${entry.clients.full_name} manually assigned from the waitlist to ${WEEKDAY_NAMES[entry.day_of_week]} ${entry.time_slot} with ${entry.therapist_name}`,
    updated_by: req.user.id
  });

  if (entry.clients.parent_id) {
    await notifyEvent(null, {
      title: "You've been assigned a therapy slot",
      body: `${entry.clients.full_name} was assigned the waitlisted ${result.sessionType} slot (${WEEKDAY_NAMES[entry.day_of_week]}s at ${entry.time_slot} with ${entry.therapist_name}).`,
      icon: 'fa-calendar-check',
      target_user: entry.clients.parent_id
    });
  }

  res.json({ schedule: result.schedule, notifiedWaitlistClient: entry.clients.full_name });
});

/**
 * POST /api/reservations/schedule-waitlist/:id/accept, parent only. Claims a
 * slot they were notified is open (see notifyWaitlistForFreedSlot's SMS/email/
 * in-app offer), creating the actual recurring schedule for them, the same
 * outcome as staff running assign-schedule on their behalf, just guardian-
 * initiated. Re-checks the slot is genuinely still free, in case it was
 * claimed by someone else (staff, or a race) before this guardian responded.
 */
router.post('/schedule-waitlist/:id/accept', async (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ error: 'Only a guardian can accept a waitlist offer.' });
  const { data: entry } = await db.from('schedule_waitlist')
    .select('*, clients(id, full_name, parent_id, therapy_type, assigned_ot_therapist_name, assigned_speech_therapist_name, initial_assessment_completed)')
    .eq('id', req.params.id).maybeSingle();
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  const client = entry.clients;
  if (!client || client.parent_id !== req.user.id) return res.status(403).json({ error: 'Not your child\'s waitlist entry' });
  if (entry.status !== 'notified') return res.status(400).json({ error: `This offer is no longer available (status: ${entry.status}).` });

  if (!client.initial_assessment_completed) {
    const { data: ia } = await db.from('reservations').select('id').eq('client_id', client.id).eq('session_type', 'Initial Assessment').eq('status', 'completed').maybeSingle();
    if (!ia) return res.status(400).json({ error: `${client.full_name} must complete an Initial Assessment before accepting a therapy schedule. Please contact the clinic.` });
  }

  const { data: alreadyHasTherapist } = await db.from('recurring_schedules')
    .select('id').eq('client_id', client.id).eq('therapist_name', entry.therapist_name).eq('status', 'active').maybeSingle();
  if (alreadyHasTherapist) {
    return res.status(409).json({ error: `${entry.therapist_name} already has an active schedule with ${client.full_name}, one session per therapist per week. Please contact the clinic.` });
  }
  const { data: clientSameSlot } = await db.from('recurring_schedules')
    .select('id').eq('client_id', client.id).eq('day_of_week', entry.day_of_week).eq('time_slot', entry.time_slot).eq('status', 'active').maybeSingle();
  if (clientSameSlot) {
    return res.status(409).json({ error: `${client.full_name} already has a schedule at that day and time. Please contact the clinic.` });
  }

  // The slot really might not be free anymore, this is the whole reason
  // accept/decline exists instead of auto-assigning: first response wins.
  const { data: slotTakenBy } = await db.from('recurring_schedules')
    .select('id').eq('day_of_week', entry.day_of_week).eq('time_slot', entry.time_slot).eq('therapist_name', entry.therapist_name).eq('status', 'active').maybeSingle();
  if (slotTakenBy) {
    await db.from('schedule_waitlist').update({ status: 'declined' }).eq('id', entry.id);
    await logAudit({ table_name: 'schedule_waitlist', record_id: entry.id, action: 'update', description: `${client.full_name}'s offer expired, slot was already taken` });
    await notifyWaitlistForFreedSlot(entry.discipline, entry.day_of_week, entry.time_slot, entry.therapist_name);
    return res.status(409).json({ error: 'Sorry, that slot was just taken. You\'ve been moved off this offer; please contact the clinic about other openings.' });
  }

  const sessionType = entry.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const { data: schedule, error: schedErr } = await db.from('recurring_schedules').insert({
    client_id: client.id, discipline: entry.discipline, day_of_week: entry.day_of_week, time_slot: entry.time_slot, therapist_name: entry.therapist_name,
    status: 'active', created_by: req.user.id
  }).select().single();
  if (schedErr) return res.status(500).json({ error: schedErr.message });

  const clientPatch = {};
  if (entry.discipline === 'OT') clientPatch.assigned_ot_therapist_name = entry.therapist_name;
  else clientPatch.assigned_speech_therapist_name = entry.therapist_name;
  if (!client.therapy_type) clientPatch.therapy_type = entry.discipline;
  else if (client.therapy_type !== entry.discipline && client.therapy_type !== 'Both') clientPatch.therapy_type = 'Both';
  await db.from('clients').update(clientPatch).eq('id', client.id);

  await db.from('schedule_waitlist').update({ status: 'accepted' }).eq('id', entry.id);
  await logAudit({
    table_name: 'recurring_schedules', record_id: schedule.id, action: 'create',
    description: `${client.full_name}'s guardian accepted a waitlisted ${sessionType} slot: ${WEEKDAY_NAMES[entry.day_of_week]}s at ${entry.time_slot} with ${entry.therapist_name}`,
    created_by: req.user.id
  });

  const body = `${client.full_name}'s guardian accepted the waitlisted ${sessionType} slot (${WEEKDAY_NAMES[entry.day_of_week]}s at ${entry.time_slot} with ${entry.therapist_name}).`;
  await notifyEvent(null, { title: 'Waitlist offer accepted', body, icon: 'fa-calendar-check', target_role: 'admin' });
  await notifyEvent(null, { title: 'Waitlist offer accepted', body, icon: 'fa-calendar-check', target_role: 'staff' });

  res.json({ schedule });
});

/**
 * POST /api/reservations/schedule-waitlist/:id/decline, parent only. Turns
 * down an offered slot, cascading to whoever's next in line for that exact
 * slot (same notifyWaitlistForFreedSlot as a discharge), instead of it just
 * sitting there un-offered to anyone until staff notices.
 */
router.post('/schedule-waitlist/:id/decline', async (req, res) => {
  if (req.user.role !== 'parent') return res.status(403).json({ error: 'Only a guardian can decline a waitlist offer.' });
  const { data: entry } = await db.from('schedule_waitlist').select('*, clients(full_name, parent_id)').eq('id', req.params.id).maybeSingle();
  if (!entry) return res.status(404).json({ error: 'Waitlist entry not found' });
  if (!entry.clients || entry.clients.parent_id !== req.user.id) return res.status(403).json({ error: 'Not your child\'s waitlist entry' });
  if (entry.status !== 'notified') return res.status(400).json({ error: `This offer is no longer active (status: ${entry.status}).` });

  await db.from('schedule_waitlist').update({ status: 'declined' }).eq('id', entry.id);
  await logAudit({
    table_name: 'schedule_waitlist', record_id: entry.id, action: 'update',
    description: `${entry.clients.full_name}'s guardian declined the waitlisted slot (${WEEKDAY_NAMES[entry.day_of_week]}s at ${entry.time_slot} with ${entry.therapist_name})`,
    updated_by: req.user.id
  });

  const notifiedWaitlistClient = await notifyWaitlistForFreedSlot(entry.discipline, entry.day_of_week, entry.time_slot, entry.therapist_name);
  res.json({ ok: true, notifiedWaitlistClient });
});

export default router;

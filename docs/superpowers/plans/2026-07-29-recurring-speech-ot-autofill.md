# Recurring Speech/OT Auto-Fill & Guardian Cancellation-Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once staff/admin fix a client's weekly Speech/OT schedule, the system keeps a rolling 2-week window of `confirmed` reservations generated automatically (crediting/discharging correctly, skipping clinic holidays), removes the guardian's ability to manually book those two disciplines, and replaces it with a read-only schedule view plus a cancellation-request-with-attachment flow that staff/admin review as excused (credit/drop, no fee) or unexcused (no-show fee, still credits if it was paid).

**Architecture:** New `server/lib/recurringFill.js` holds the pure fill logic, called both synchronously (the instant a schedule is created/a waitlist slot is assigned) and by a new `server/lib/recurringFillSweep.js` timer (mirroring every other sweep in `server/index.js`) that tops the horizon back up to 2 weeks every day as time passes. A new `cancellation_requests` table plus routes in `server/routes/reservations.js` carry the guardian's request and staff's verdict; the verdict's side effects reuse/extend `server/lib/noShow.js`. Client-side changes are additive edits to the existing monolithic `ParentPortal.jsx` (guardian) and `Reservations.jsx`/`SlotActionsModal.jsx` (staff/admin) — this codebase has no per-feature page split, so new UI follows that same convention rather than introducing one.

**Tech Stack:** Node/Express + Supabase (Postgres, plain SQL migrations run by hand in the Supabase SQL editor, no migration runner), React 18 + Vite (no router — `page` is local component state), multer + Supabase Storage for file uploads. No automated test runner exists anywhere in this repo (confirmed: no jest/vitest/mocha, no `*.test.js` files) — this plan follows the codebase's own existing convention instead: a manual, run-by-hand verification script per feature under `server/scripts/`, mirroring `server/scripts/verify-shifts.js` etc. Do not introduce a new test framework as part of this plan.

## Global Constraints

- Auto-fill horizon is a rolling **14 days** (2 weeks) from today, refilled daily. This is also the advance-payment cap: a session simply cannot be paid for before it exists.
- Auto-fill and everything derived from it (advance-payment cap, guardian booking removal, reschedule restriction, cancellation-request flow) applies **only** to `session_type` = `'Occupational Therapy'` or `'Speech Therapy'` reservations tied to an active `recurring_schedules` row. Initial Assessment and make-up sessions (`is_makeup = true`) are completely untouched by every task in this plan.
- Every new DB change is a new file `supabase/migration_<snake_case_description>.sql`, lower-case SQL keywords (dominant existing style), opening multi-line `--` comment explaining *why* and cross-referencing the consuming file, run by hand in the Supabase SQL editor (there is no migration runner to invoke).
- Every side-effect function (credit release, fee creation, notifications, audit log) must reuse the existing helpers already in `server/lib/noShow.js` (`releaseSessionPaymentAsCredit`, `checkConsecutiveAbsences`) rather than re-implementing them — this repo already has exactly the credit/fee primitives this feature needs.
- `todayPH()` (PH-timezone "today" as `YYYY-MM-DD`) is duplicated per-file today (`noShow.js`, `recurringSchedules.js`, `reservations.js`) rather than shared — follow that existing convention, don't introduce a shared util as part of this plan (YAGNI, matches current style).
- No automated tests exist in this repo. Verification for every task is: (a) a manual run-by-hand script under `server/scripts/`, and (b) manual exercise through the running app (dev server + browser) for anything UI-facing.

---

## Assumption to confirm before/while executing Task 8

The spec says guardians lose "manual booking for speech or occupational." Make-up sessions currently have `session_type` = `'Occupational Therapy'`/`'Speech Therapy'` too (just `is_makeup: true`), and today a guardian *could* self-book one (same `POST /reservations` flow, no staff-only gate on `is_makeup`). This plan assumes make-up sessions become **staff/admin-initiated only** going forward (consistent with "all Speech/OT session management moves to staff, guardians shift to view + request"), which is why the Reschedule-button task keeps make-ups reschedulable — by staff. If that's wrong and guardians should still self-book make-ups, Task 8's removal needs a carve-out and Task 8 should be revisited before merging.

---

## File Structure

New files:
- `supabase/migration_cancellation_requests.sql` — new table.
- `server/lib/recurringFill.js` — `fillReservationsForSchedule(schedule, actorId)`, the pure "generate confirmed reservations up to the 2-week horizon" logic, callable from both a route handler and a sweep.
- `server/lib/recurringFillSweep.js` — `sweepRecurringFill()`, daily timer entry point, loops every active schedule and calls `fillReservationsForSchedule`.
- `server/scripts/verify-recurring-fill.js` — manual verification script (create a test schedule, run the fill, print what got created).

Modified files:
- `server/routes/reservations.js` — export `isClinicHoliday` and `ensurePaymentForReservation` (currently private to this file, `recurringFill.js` needs both); call the fill immediately after a schedule is created (`POST /:clientId/assign-schedule`); new cancellation-request routes.
- `server/lib/recurringSchedules.js` — call the fill immediately after `assignWaitlistEntry` creates a schedule.
- `server/routes/settings.js` — `POST /holidays` triggers auto-excused-cancellation of any already-generated confirmed reservation on that date.
- `server/routes/payments.js` — advance-payment horizon guard on the two QRPh checkout routes.
- `server/lib/noShow.js` — new `applyCancellationReviewSideEffects(reservation, request, excused, actorId)`.
- `server/index.js` — register the new sweep.
- `client/src/portals/parent/ParentPortal.jsx` — remove Speech/OT from the manual booking type picker and the recurring "quick book" UI; add a read-only schedule view; add the cancellation-request form + the guardian's own request list.
- `client/src/portals/admin/pages/Reservations.jsx` — new "Cancellation Requests" tab/section.
- `client/src/portals/admin/pages/reservations/SlotActionsModal.jsx` — hide the Reschedule block for a locked fixed-schedule occurrence (one-line condition change; make-ups and Initial Assessment are already unaffected since they never set `isLockedToSchedule`).

---

### Task 1: `cancellation_requests` table

**Files:**
- Create: `supabase/migration_cancellation_requests.sql`

**Interfaces:**
- Produces: table `cancellation_requests(id, reservation_id, client_id, requested_by, week_of, attachment_path, attachment_bucket, status, reviewed_by, reviewed_at, review_note, created_at)` consumed by Tasks 8, 9, 11.

- [ ] **Step 1: Write the migration**

```sql
-- Migration: guardian-submitted cancellation requests for a fixed Speech/OT
-- weekly slot's specific week's occurrence, with an attached proof file, for
-- staff/admin to review as Excused or Unexcused (see applyCancellationReviewSideEffects
-- in server/lib/noShow.js and the review routes in server/routes/reservations.js).
-- Distinct from a direct staff/admin cancel (existing applyCancelSideEffects,
-- always treated as excused/legitimate) -- this table exists specifically for
-- the guardian-initiated, staff-reviewed path with a paper trail (attachment +
-- reviewer + verdict), since these fixed slots are no longer guardian-cancellable
-- outright once assigned.
-- Run this in Supabase Dashboard -> SQL Editor.

create table cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  requested_by uuid references profiles (id) on delete set null,
  attachment_path text not null,
  attachment_bucket text not null default 'private-uploads',
  note text,
  status text not null default 'pending' check (status in ('pending', 'excused', 'unexcused')),
  reviewed_by uuid references profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

-- One live request per reservation at a time, a guardian re-submitting after
-- a reviewed one just leaves the old row as history rather than colliding.
create unique index cancellation_requests_pending_uidx on cancellation_requests (reservation_id) where status = 'pending';
create index cancellation_requests_client_idx on cancellation_requests (client_id);
create index cancellation_requests_status_idx on cancellation_requests (status);

alter table cancellation_requests enable row level security;
```

- [ ] **Step 2: Run it**

Open the Supabase Dashboard → SQL Editor for this project, paste the file's contents, run it. Expected: `CREATE TABLE`, `CREATE INDEX` ×3, `ALTER TABLE` all succeed with no errors. Confirm with:

```sql
select column_name, data_type from information_schema.columns where table_name = 'cancellation_requests' order by ordinal_position;
```

Expected: the 12 columns listed above.

- [ ] **Step 3: Commit**

```bash
git add supabase/migration_cancellation_requests.sql
git commit -m "Add cancellation_requests table for guardian cancellation review flow"
```

---

### Task 2: Export `isClinicHoliday` and `ensurePaymentForReservation` from reservations.js

**Files:**
- Modify: `server/routes/reservations.js:194` (`isClinicHoliday`), `server/routes/reservations.js:123` (`ensurePaymentForReservation`)

**Interfaces:**
- Produces: `export async function isClinicHoliday(date)` → `{ label } | null`. `export async function ensurePaymentForReservation(reservation, actorId, opts = {})` → the `payments` row (existing/created/credited).
- Consumes: nothing new, purely adding the `export` keyword to two functions that already exist verbatim.

- [ ] **Step 1: Add `export` to both function declarations**

At `server/routes/reservations.js:123`, change:
```js
async function ensurePaymentForReservation(reservation, actorId, opts = {}) {
```
to:
```js
export async function ensurePaymentForReservation(reservation, actorId, opts = {}) {
```

At `server/routes/reservations.js:194`, change:
```js
async function isClinicHoliday(date) {
```
to:
```js
export async function isClinicHoliday(date) {
```

- [ ] **Step 2: Verify nothing else broke**

Run: `node --check server/routes/reservations.js`
Expected: no output (syntax OK). This is a pure additive export, every existing internal call site in the same file keeps working unchanged.

- [ ] **Step 3: Commit**

```bash
git add server/routes/reservations.js
git commit -m "Export isClinicHoliday and ensurePaymentForReservation for reuse by recurringFill.js"
```

---

### Task 3: `server/lib/recurringFill.js` — core fill logic

**Files:**
- Create: `server/lib/recurringFill.js`

**Interfaces:**
- Consumes: `isClinicHoliday(date)` and `ensurePaymentForReservation(reservation, actorId, opts)` from `server/routes/reservations.js` (Task 2); `getTherapistShifts, worksOn, isLunchHour, workDayIndex, hourLabel, labelToHour` from `server/routes/shifts.js`; `logAudit` from `server/lib/audit.js`.
- Produces: `export async function fillReservationsForSchedule(schedule, actorId)` → `{ created: number, skippedHolidays: number }`, consumed by Task 5 (immediate call on schedule creation) and Task 4 (the sweep).

`schedule` is a full `recurring_schedules` row: `{ id, client_id, discipline, day_of_week, time_slot, therapist_name, status }`.

- [ ] **Step 1: Write the file**

```js
import { db } from '../supabase.js';
import { logAudit } from './audit.js';
import { isClinicHoliday, ensurePaymentForReservation } from '../routes/reservations.js';
import { getTherapistShifts, worksOn, isLunchHour, labelToHour } from '../routes/shifts.js';

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of server timezone. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** How far ahead the auto-fill keeps confirmed reservations generated. Also
 *  doubles as the advance-payment cap (see server/routes/payments.js): a
 *  session simply can't be paid for before it's been generated, so there's
 *  nothing further to guard there beyond this one horizon. */
export const FILL_HORIZON_DAYS = 14;

/**
 * Every date in [today, today+FILL_HORIZON_DAYS] that falls on `dayOfWeek`
 * (0=Sunday..6=Saturday, matching recurring_schedules.day_of_week and
 * JS Date#getUTCDay()).
 */
function upcomingWeekdayDates(dayOfWeek) {
  const dates = [];
  const start = new Date(todayPH() + 'T00:00:00Z');
  for (let i = 0; i <= FILL_HORIZON_DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (d.getUTCDay() === dayOfWeek) dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Generates `confirmed` reservations for one active recurring schedule, for
 * every occurrence of its day/time within the rolling FILL_HORIZON_DAYS
 * window that doesn't already have a reservation on file. Skips a date that's
 * a clinic-wide holiday (set ahead of time, see isClinicHoliday) or one the
 * therapist no longer works (shift changed since the schedule was assigned) —
 * neither case creates a confirmed booking nobody can actually deliver.
 * Idempotent: safe to call repeatedly (assignment time, daily sweep), a date
 * that already has a live reservation is left untouched.
 */
export async function fillReservationsForSchedule(schedule, actorId) {
  if (schedule.status !== 'active') return { created: 0, skippedHolidays: 0 };

  const sessionType = schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy';
  const shifts = await getTherapistShifts();
  const shift = shifts.find(s => s.name === schedule.therapist_name);
  const hour = labelToHour(schedule.time_slot);

  const candidateDates = upcomingWeekdayDates(schedule.day_of_week);
  if (!candidateDates.length) return { created: 0, skippedHolidays: 0 };

  const { data: existing } = await db.from('reservations')
    .select('date').eq('recurring_schedule_id', schedule.id).in('date', candidateDates)
    .not('status', 'in', '(cancelled,declined)');
  const existingDates = new Set((existing || []).map(r => r.date));

  let created = 0;
  let skippedHolidays = 0;

  for (const date of candidateDates) {
    if (existingDates.has(date)) continue;
    if (await isClinicHoliday(date)) { skippedHolidays++; continue; }
    if (shift && (!worksOn(shift, date) || (hour != null && isLunchHour(shift, hour)))) continue;

    const { data: reservation, error } = await db.from('reservations').insert({
      client_id: schedule.client_id,
      therapist_name: schedule.therapist_name,
      date,
      time_slot: schedule.time_slot,
      session_type: sessionType,
      duration_min: 60,
      status: 'confirmed',
      channel: 'auto-fill',
      created_by: actorId,
      recurring_schedule_id: schedule.id,
      is_makeup: false
    }).select().single();
    if (error) {
      // A concurrent fill (assignment-time call racing the sweep) can lose the
      // unique-slot index race here, that date simply already exists now,
      // nothing to do.
      if (error.code === '23505') continue;
      console.error(`Auto-fill failed for schedule ${schedule.id} on ${date}:`, error.message);
      continue;
    }

    await ensurePaymentForReservation(reservation, actorId, {});
    created++;
  }

  if (created) {
    await logAudit({
      table_name: 'recurring_schedules', record_id: schedule.id, action: 'update',
      description: `Auto-filled ${created} confirmed ${sessionType} session(s) through ${candidateDates[candidateDates.length - 1]}`,
      created_by: actorId
    });
  }

  return { created, skippedHolidays };
}
```

- [ ] **Step 2: Verify it loads**

Run: `node --check server/lib/recurringFill.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add server/lib/recurringFill.js
git commit -m "Add fillReservationsForSchedule: rolling 2-week confirmed-reservation auto-fill"
```

---

### Task 4: Daily sweep to keep the horizon topped up

**Files:**
- Create: `server/lib/recurringFillSweep.js`
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `fillReservationsForSchedule` from Task 3.
- Produces: `export async function sweepRecurringFill()`, registered on a daily timer in `server/index.js`.

- [ ] **Step 1: Write the sweep**

```js
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
```

- [ ] **Step 2: Register it in `server/index.js`**

Add the import alongside the other sweep imports (after line 26):
```js
import { sweepMissedBookings } from './lib/missedBookingSweep.js';
import { sweepRecurringFill } from './lib/recurringFillSweep.js';
```

Add the timer registration after the existing `sweepMissedBookings()` block (after line 132):
```js

// Keeps every active Speech/OT fixed schedule's confirmed reservations
// topped up to the rolling 2-week horizon (see server/lib/recurringFill.js),
// since one day passing moves that horizon's far edge forward by a day.
// Once daily is enough resolution for a multi-day window; the immediate call
// below means a server restart doesn't wait a full day to catch up.
const RECURRING_FILL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setInterval(sweepRecurringFill, RECURRING_FILL_SWEEP_INTERVAL_MS);
sweepRecurringFill();
```

- [ ] **Step 3: Verify it loads and runs**

Run: `node --check server/lib/recurringFillSweep.js && node --check server/index.js`
Expected: no output (syntax OK).

Start the server (`npm run dev` in `server/`, or however it's normally started) and check the console for `sweepRecurringFill failed` — expect no such line, meaning it ran cleanly on startup.

- [ ] **Step 4: Commit**

```bash
git add server/lib/recurringFillSweep.js server/index.js
git commit -m "Register daily sweep to top up the recurring-schedule auto-fill horizon"
```

---

### Task 5: Call the fill the instant a schedule is created

**Files:**
- Modify: `server/routes/reservations.js:1541-1576` (`POST /:clientId/assign-schedule`)
- Modify: `server/lib/recurringSchedules.js` (`assignWaitlistEntry`, around line 125-140)

**Interfaces:**
- Consumes: `fillReservationsForSchedule` from `../lib/recurringFill.js`.

- [ ] **Step 1: Import in `reservations.js`**

Near the top imports (after line 9):
```js
import { dischargeSchedule, notifyWaitlistForFreedSlot, notifyWaitlistEntry, assignWaitlistEntry } from '../lib/recurringSchedules.js';
import { fillReservationsForSchedule } from '../lib/recurringFill.js';
```

- [ ] **Step 2: Call it right after the schedule insert succeeds**

In the `POST /:clientId/assign-schedule` handler, right after the existing block:
```js
  const { data: schedule, error: schedErr } = await db.from('recurring_schedules').insert({
    client_id: client.id, discipline, day_of_week, time_slot, therapist_name,
    status: 'active', created_by: req.user.id
  }).select().single();
  if (schedErr) return res.status(500).json({ error: schedErr.message });
```
add:
```js

  // Fixed Speech/OT slots are pre-filled with confirmed sessions immediately,
  // no more manual weekly booking — see server/lib/recurringFill.js.
  await fillReservationsForSchedule(schedule, req.user.id);
```

- [ ] **Step 3: Same for waitlist auto-assignment in `recurringSchedules.js`**

Add the import at the top of `server/lib/recurringSchedules.js` (after line 6):
```js
import { releaseSessionPaymentAsCredit } from './noShow.js';
import { fillReservationsForSchedule } from './recurringFill.js';
```

In `assignWaitlistEntry`, right after:
```js
  const { data: schedule, error: schedErr } = await db.from('recurring_schedules').insert({
    client_id: client.id, discipline: entry.discipline, day_of_week: entry.day_of_week, time_slot: entry.time_slot, therapist_name: entry.therapist_name,
    status: 'active', created_by: actorId
  }).select().single();
  if (schedErr) throw new Error(schedErr.message);
```
add:
```js

  await fillReservationsForSchedule(schedule, actorId);
```

- [ ] **Step 4: Verify**

Run: `node --check server/routes/reservations.js && node --check server/lib/recurringSchedules.js`
Expected: no output.

Manually verify through the app: as staff/admin, assign a new Speech or OT fixed schedule to a test client, then check the client's Reservations calendar — expect up to 2 upcoming confirmed occurrences to already exist without booking them by hand (or fewer if a holiday/therapist day-off falls in the window).

- [ ] **Step 5: Commit**

```bash
git add server/routes/reservations.js server/lib/recurringSchedules.js
git commit -m "Auto-fill confirmed reservations the instant a fixed Speech/OT schedule is assigned"
```

---

### Task 6: Skip generation for holidays already set, auto-excuse ones set late

**Files:**
- Modify: `server/routes/settings.js:153-173` (`POST /holidays`)

**Interfaces:**
- Consumes: `applyCancelSideEffects` from `../lib/noShow.js` (already does exactly "excused: paid → credit, unpaid → dropped").
- Note: the "skip generation for a holiday set ahead of time" half of this requirement is **already done by Task 3** (`fillReservationsForSchedule` calls `isClinicHoliday(date)` before inserting). This task only needs to handle the other half — a holiday added for a date where a confirmed reservation *already exists*.

- [ ] **Step 1: Import `applyCancelSideEffects` in `settings.js`**

Check the top of `server/routes/settings.js` for its existing imports, then add:
```js
import { applyCancelSideEffects } from '../lib/noShow.js';
```

- [ ] **Step 2: Auto-cancel existing confirmed sessions for that date**

In `POST /holidays`, right after the insert succeeds and before the `logAudit` call:
```js
router.post('/holidays', requireAuth, requireRole('admin', 'staff'), async (req, res) => {
  const { date, label } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid date is required' });
  }
  const { data, error } = await db.from('clinic_holidays')
    .insert({ date, label: (label || '').trim() || null, created_by: req.user.id })
    .select().single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'That date is already marked as a closure' });
    return res.status(500).json({ error: error.message });
  }

  // A closure announced AFTER confirmed Speech/OT sessions already exist for
  // that date (the ahead-of-time case is instead handled by
  // fillReservationsForSchedule never generating one) auto-cancels them as
  // excused, no guardian action or attachment needed, it's the clinic's own
  // closure, not the family's absence.
  const { data: affected } = await db.from('reservations')
    .select('*').eq('date', date).in('status', ['confirmed', 'rescheduled'])
    .in('session_type', ['Occupational Therapy', 'Speech Therapy']);
  for (const r of affected || []) {
    await db.from('reservations').update({ status: 'cancelled' }).eq('id', r.id);
    await applyCancelSideEffects(r, req.user.id);
  }

  await logAudit({
    table_name: 'clinic_holidays', record_id: data.id, action: 'create',
    description: `Marked ${date} as a clinic closure${label ? ` (${label})` : ''}` + (affected?.length ? `, ${affected.length} confirmed session(s) auto-excused` : ''),
    created_by: req.user.id
  });

  res.status(201).json(data);
});
```

- [ ] **Step 3: Verify**

Run: `node --check server/routes/settings.js`
Expected: no output.

Manually verify: with a test client's confirmed Speech/OT session already generated for, say, 5 days from now, add a clinic holiday for that exact date via the admin Employee Scheduling tab. Reload the client's reservations — expect that occurrence to now show as cancelled, and (if it had been marked paid) a floating credit to appear on the client's payments.

- [ ] **Step 4: Commit**

```bash
git add server/routes/settings.js
git commit -m "Auto-excuse confirmed Speech/OT sessions when a late clinic closure is declared"
```

---

### Task 7: Advance-payment cap guard

**Files:**
- Modify: `server/routes/payments.js` (`POST /checkout/combined` and `POST /:id/qrph`)

**Interfaces:**
- Consumes: `FILL_HORIZON_DAYS` from `../lib/recurringFill.js`.

Since only `FILL_HORIZON_DAYS` (14) days of confirmed reservations ever exist for a fixed Speech/OT slot, the cap is naturally enforced by "you can't pay for a reservation that doesn't exist yet." This step adds an explicit guard so the rule fails loudly and correctly if the horizon logic is ever changed later, rather than silently relying on that side effect.

- [ ] **Step 1: Add the horizon import**

Near the top of `server/routes/payments.js`:
```js
import { FILL_HORIZON_DAYS } from '../lib/recurringFill.js';
```

- [ ] **Step 2: Add the guard helper**

Near the top of the file, alongside other small helpers:
```js
/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8). */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** True if `date` is further out than the auto-fill horizon allows paying
 *  ahead for — only meaningful for a fixed-schedule Speech/OT session, an
 *  Initial Assessment or make-up invoice has no such cap. */
function beyondAdvancePaymentHorizon(reservation) {
  if (!reservation.recurring_schedule_id || reservation.is_makeup) return false;
  const daysAhead = Math.round((Date.parse(reservation.date) - Date.parse(todayPH())) / 86400000);
  return daysAhead > FILL_HORIZON_DAYS;
}
```

- [ ] **Step 3: Call the guard in `POST /checkout/combined`**

Find where `POST /checkout/combined` loads the reservations for the payment ids it's about to checkout (look for the query that joins `payments` to `reservations` before calling `generateQrph`). Add, right after that load and before any PayMongo call:
```js
  for (const p of paymentsToCheckout) {
    if (p.reservations && beyondAdvancePaymentHorizon(p.reservations)) {
      return res.status(400).json({ error: `${p.reservations.session_type} on ${p.reservations.date} is too far ahead to pay for yet, it opens up ${FILL_HORIZON_DAYS} days before its date.` });
    }
  }
```
(Adjust `paymentsToCheckout`/`p.reservations` to match the exact variable names already in that route — the query already joins to `reservations` per the existing invoice-detail select, reuse that same joined object rather than issuing a new query.)

- [ ] **Step 4: Same guard in `POST /:id/qrph`**

In that route, after the existing `payment` row (with its joined reservation) is loaded and before `generateQrph`/`retryQrphOnIntent` is called:
```js
  if (payment.reservations && beyondAdvancePaymentHorizon(payment.reservations)) {
    return res.status(400).json({ error: `${payment.reservations.session_type} on ${payment.reservations.date} is too far ahead to pay for yet, it opens up ${FILL_HORIZON_DAYS} days before its date.` });
  }
```

- [ ] **Step 5: Verify**

Run: `node --check server/routes/payments.js`
Expected: no output.

Manually verify: this should be unreachable in practice since no reservation beyond the horizon exists to select in the first place — confirm by checking the guardian/staff payment UI simply has nothing to pay past 2 weeks out, and (optional, defensive check only) that manually inserting a test `confirmed` reservation 20 days out and calling its QRPh endpoint directly returns the 400 above.

- [ ] **Step 6: Commit**

```bash
git add server/routes/payments.js
git commit -m "Guard payment checkout against paying beyond the 2-week advance-payment horizon"
```

---

### Task 8: Cancellation-request server routes (create, list, review)

**Files:**
- Modify: `server/routes/reservations.js`

**Interfaces:**
- Consumes: `cancellation_requests` table (Task 1); `applyCancellationReviewSideEffects` from `../lib/noShow.js` (Task 9 — written in parallel, this task's review route calls it).
- Produces: `POST /:id/cancellation-requests` (guardian, multipart), `GET /cancellation-requests?status=pending` (staff/admin), `PUT /cancellation-requests/:id/review` (staff/admin, `{ verdict: 'excused'|'unexcused', note? }`).

Storage: reuses the existing **private, signed-URL** bucket pattern from `server/routes/clients.js`'s `ARCHIVE_BUCKET` (not the public `uploads` bucket used for photos) since an attachment may contain private medical/personal proof.

- [ ] **Step 1: Add multer + bucket setup**

Near the top of `server/routes/reservations.js`, alongside other imports:
```js
import multer from 'multer';
```

After the existing top-level constants (near `PAYMENT_METHODS`):
```js
const CANCELLATION_ATTACHMENT_BUCKET = 'cancellation-attachments';
const cancellationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype))
});

// Created once at startup if missing, same pattern as cms.js's 'uploads'
// bucket, but private (no public flag) since a cancellation-proof attachment
// (e.g. a medical certificate) is guardian-private, only ever served back via
// a short-lived signed URL, never a guessable public one.
(async () => {
  const { data: buckets } = await db.storage.listBuckets();
  if (!buckets?.some(b => b.name === CANCELLATION_ATTACHMENT_BUCKET)) {
    await db.storage.createBucket(CANCELLATION_ATTACHMENT_BUCKET, { public: false });
  }
})();
```

- [ ] **Step 2: `POST /:id/cancellation-requests`**

Add near the other reservation-scoped routes (a good spot: right before the discharge/schedule routes section, since it's reservation-not-schedule scoped):
```js
/**
 * POST /api/reservations/:id/cancellation-requests, multipart with a `file`
 * field (the proof attachment) and optional `note`. Guardian-only (their own
 * child's reservation) for a fixed-schedule Speech/OT occurrence — this is
 * the ONLY cancellation path left to them for these sessions now that manual
 * booking/cancelling is staff/admin-only, see the client-portal changes.
 * Creates a 'pending' request for staff/admin to review (see PUT
 * /cancellation-requests/:id/review below); does not touch the reservation
 * itself yet.
 */
router.post('/:id/cancellation-requests', (req, res, next) => {
  cancellationUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A proof attachment (JPEG, PNG, WEBP, or PDF, max 5MB) is required.' });

  const { data: reservation } = await db.from('reservations')
    .select('*, clients(parent_id, full_name)').eq('id', req.params.id).maybeSingle();
  if (!reservation) return res.status(404).json({ error: 'Reservation not found' });
  if (req.user.role === 'parent' && reservation.clients?.parent_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your child\'s reservation' });
  }
  if (!reservation.recurring_schedule_id || reservation.is_makeup) {
    return res.status(400).json({ error: 'Only a fixed weekly Speech/OT session can be requested for cancellation this way.' });
  }
  if (!['confirmed', 'rescheduled'].includes(reservation.status)) {
    return res.status(400).json({ error: 'This session is no longer in a cancellable state.' });
  }

  const EXT_FOR_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
  const ext = EXT_FOR_TYPE[req.file.mimetype] || 'bin';
  const path = `${reservation.id}-${Date.now()}.${ext}`;
  const { error: upErr } = await db.storage.from(CANCELLATION_ATTACHMENT_BUCKET).upload(path, req.file.buffer, {
    contentType: req.file.mimetype, upsert: false
  });
  if (upErr) return res.status(500).json({ error: 'Failed to upload attachment: ' + upErr.message });

  const { data: request, error } = await db.from('cancellation_requests').insert({
    reservation_id: reservation.id,
    client_id: reservation.client_id,
    requested_by: req.user.id,
    attachment_path: path,
    attachment_bucket: CANCELLATION_ATTACHMENT_BUCKET,
    note: (req.body?.note || '').trim() || null
  }).select().single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A cancellation request for this session is already pending review.' });
    return res.status(500).json({ error: error.message });
  }

  await logAudit({
    table_name: 'cancellation_requests', record_id: request.id, action: 'create',
    description: `Cancellation requested for ${reservation.session_type} on ${reservation.date} ${reservation.time_slot} (${reservation.clients?.full_name || 'client'})`,
    created_by: req.user.id
  });
  await notifyEvent(null, {
    title: 'Cancellation request submitted',
    body: `${reservation.clients?.full_name || 'A guardian'} requested to cancel ${reservation.session_type} on ${reservation.date} at ${reservation.time_slot}, review it in Reservations.`,
    icon: 'fa-file-circle-question',
    target_role: 'admin'
  });
  await notifyEvent(null, {
    title: 'Cancellation request submitted',
    body: `${reservation.clients?.full_name || 'A guardian'} requested to cancel ${reservation.session_type} on ${reservation.date} at ${reservation.time_slot}, review it in Reservations.`,
    icon: 'fa-file-circle-question',
    target_role: 'staff'
  });

  res.status(201).json(request);
});
```

- [ ] **Step 3: `GET /cancellation-requests`**

```js
/**
 * GET /api/reservations/cancellation-requests?status=pending, staff/admin
 * only. Lists requests newest-first with the reservation + client name joined
 * in, so the review UI needs no follow-up round trip per row.
 */
router.get('/cancellation-requests', requireRole('admin', 'staff'), async (req, res) => {
  let q = db.from('cancellation_requests')
    .select('*, reservations(date, time_slot, session_type, therapist_name, status), clients(full_name)')
    .order('created_at', { ascending: false });
  if (req.query.status) q = q.eq('status', req.query.status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
```

- [ ] **Step 4: `GET /cancellation-requests/:id/attachment`**

Signed-URL fetch, mirrors `clients.js`'s archive-snapshot pattern:
```js
/** GET /api/reservations/cancellation-requests/:id/attachment, staff/admin
 *  only, a short-lived signed URL to view the guardian's proof attachment
 *  (private bucket, never a public/guessable URL). */
router.get('/cancellation-requests/:id/attachment', requireRole('admin', 'staff'), async (req, res) => {
  const { data: request } = await db.from('cancellation_requests').select('attachment_path, attachment_bucket').eq('id', req.params.id).maybeSingle();
  if (!request) return res.status(404).json({ error: 'Request not found' });
  const { data, error } = await db.storage.from(request.attachment_bucket).createSignedUrl(request.attachment_path, 60);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.signedUrl });
});
```

- [ ] **Step 5: `PUT /cancellation-requests/:id/review`**

```js
/**
 * PUT /api/reservations/cancellation-requests/:id/review  { verdict: 'excused'|'unexcused', note? }
 * Staff/admin only. Resolves the request and applies the matching side
 * effects to the underlying reservation (see applyCancellationReviewSideEffects
 * in server/lib/noShow.js): excused = credit/drop, no fee; unexcused = a
 * no-show fee always applies, on top of a credit if it was already paid.
 */
router.put('/cancellation-requests/:id/review', requireRole('admin', 'staff'), async (req, res) => {
  const { verdict, note } = req.body || {};
  if (!['excused', 'unexcused'].includes(verdict)) {
    return res.status(400).json({ error: "verdict must be 'excused' or 'unexcused'" });
  }
  const { data: request } = await db.from('cancellation_requests').select('*, reservations(*)').eq('id', req.params.id).maybeSingle();
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already reviewed.' });

  const reservation = request.reservations;
  await db.from('reservations').update({ status: 'cancelled' }).eq('id', reservation.id);
  await applyCancellationReviewSideEffects(reservation, verdict === 'excused', req.user.id);

  const { data: updated, error } = await db.from('cancellation_requests').update({
    status: verdict, reviewed_by: req.user.id, reviewed_at: new Date().toISOString(), review_note: (note || '').trim() || null
  }).eq('id', request.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'cancellation_requests', record_id: request.id, action: 'update',
    description: `Cancellation request for ${reservation.session_type} on ${reservation.date} ${reservation.time_slot} reviewed as ${verdict}`,
    updated_by: req.user.id
  });

  res.json(updated);
});
```

- [ ] **Step 6: Wire the `applyCancellationReviewSideEffects` import**

Update the existing noShow import line near the top of the file:
```js
import { applyNoShowSideEffects, applyCancelSideEffects, releaseSessionPaymentAsCredit, applyCancellationReviewSideEffects } from '../lib/noShow.js';
```

- [ ] **Step 7: Verify**

Run: `node --check server/routes/reservations.js`
Expected: no output. (Full end-to-end verification happens in Task 9's step, since `applyCancellationReviewSideEffects` doesn't exist until then — do Task 9 before manually testing Task 8's routes.)

- [ ] **Step 8: Commit**

```bash
git add server/routes/reservations.js
git commit -m "Add cancellation-request create/list/review routes for guardian-submitted fixed-slot cancellations"
```

---

### Task 9: `applyCancellationReviewSideEffects` in noShow.js

**Files:**
- Modify: `server/lib/noShow.js`

**Interfaces:**
- Consumes: `releaseSessionPaymentAsCredit`, `checkConsecutiveAbsences` (already in this file), `NO_SHOW_FEE` from `./billing.js`.
- Produces: `export async function applyCancellationReviewSideEffects(reservation, excused, actorId)`, consumed by Task 8's review route.

This mirrors `applyCancelSideEffects` (excused path — always was excused, no `excused` param) and `applyNoShowSideEffects` (fee logic, keyed by `excused` boolean) but is neither: the **unexcused** path here must fire the no-show fee like a no-show would, while the reservation's terminal status is `'cancelled'` (already set by the caller in Task 8), not `'no_show'`. Rather than overload either existing function with new meaning, this is a new function that composes the same underlying primitives both already use.

- [ ] **Step 1: Write the function**

Add to `server/lib/noShow.js`, after `applyCancelSideEffects`:

```js
/**
 * Side effects of a STAFF/ADMIN REVIEW VERDICT on a guardian-submitted
 * cancellation request (see PUT /reservations/cancellation-requests/:id/review),
 * for a fixed Speech/OT weekly slot's specific occurrence. Distinct from
 * applyCancelSideEffects (a direct staff/admin cancel, always treated as a
 * legitimate excused reason with no review step) and applyNoShowSideEffects
 * (a genuine missed session, reservation.status becomes 'no_show') — this one
 * is reached only through the guardian-request-with-attachment flow, and the
 * reservation's terminal status is 'cancelled' either way (set by the caller
 * before this runs).
 *
 * excused: true  -> same as a legitimate cancellation: paid invoice becomes a
 *                    credit, unpaid invoice is dropped, no fee, counts as an
 *                    excused absence for the 3-consecutive-absence policy.
 * excused: false -> a no-show fee ALWAYS applies (the guardian cancelled
 *                    without a reason staff accepted), on top of (never
 *                    instead of) crediting an already-paid invoice: paid ->
 *                    credit + fee; unpaid -> that pending session charge is
 *                    dropped and replaced by the fee. Counts as an unexcused
 *                    absence for the 3-consecutive-absence policy.
 */
export async function applyCancellationReviewSideEffects(reservation, excused, actorId) {
  await db.from('reservations').update({ no_show_excused: excused }).eq('id', reservation.id);

  const { data: client } = await db.from('clients').select('full_name, parent_id').eq('id', reservation.client_id).maybeSingle();
  const guardianId = client?.parent_id || null;

  if (excused) {
    await db.from('payments').delete().eq('reservation_id', reservation.id).eq('status', 'pending');
    const credited = await releaseSessionPaymentAsCredit(reservation, 'Cancellation request excused');
    if (guardianId) {
      await notifyEvent(null, {
        title: 'Cancellation request excused',
        body: `Your cancellation request for ${reservation.date} at ${reservation.time_slot} was excused, no fee was charged.${credited ? ' Your payment for it will be applied to your next session.' : ''}`,
        icon: 'fa-circle-check',
        target_user: guardianId
      });
    }
  } else {
    // Same idempotency guard as applyNoShowSideEffects: the (reservation_id,
    // fee_type) unique index means calling this twice never double-charges.
    const { data: existingFee } = await db.from('payments').select('id')
      .eq('reservation_id', reservation.id).eq('fee_type', 'no_show_fee').maybeSingle();
    if (!existingFee) {
      // Unpaid session charge is superseded by the fee, not left standing
      // alongside it, same "one outstanding charge for this miss" shape as
      // every other unexcused-absence path in this file.
      await db.from('payments').delete().eq('reservation_id', reservation.id).eq('fee_type', 'session').eq('status', 'pending');
      const credited = await releaseSessionPaymentAsCredit(reservation, 'Cancellation request unexcused, no-show fee applied');

      const invoice_no = await genInvoiceNo();
      const { error: feeErr } = await db.from('payments').insert({
        client_id: reservation.client_id, reservation_id: reservation.id, fee_type: 'no_show_fee',
        amount: NO_SHOW_FEE, method: 'Unpaid', status: 'pending', invoice_no
      });
      if (!feeErr && guardianId) {
        await notifyEvent(null, {
          title: 'Cancellation request unexcused, no-show fee added',
          body: `Your cancellation request for ${reservation.date} at ${reservation.time_slot} was not excused. A ₱${NO_SHOW_FEE} no-show fee was added.${credited ? ' Your payment for that session will be applied to your next one.' : ''}`,
          icon: 'fa-triangle-exclamation',
          target_user: guardianId
        });
      }
    }
  }

  await checkConsecutiveAbsences({ ...reservation, no_show_excused: excused });
}
```

- [ ] **Step 2: Verify**

Run: `node --check server/lib/noShow.js`
Expected: no output.

- [ ] **Step 3: End-to-end manual verification of Tasks 8+9**

Write `server/scripts/verify-cancellation-review.js`:
```js
// Manual verification script (no automated test runner in this repo).
// Run: node server/scripts/verify-cancellation-review.js
// Prints the before/after payments state for one excused and one unexcused
// review, against real test data you supply (edit the ids below).
import { db } from '../supabase.js';
import { applyCancellationReviewSideEffects } from '../lib/noShow.js';

const RESERVATION_ID = process.argv[2];
const VERDICT = process.argv[3]; // 'excused' or 'unexcused'

if (!RESERVATION_ID || !['excused', 'unexcused'].includes(VERDICT)) {
  console.error('Usage: node server/scripts/verify-cancellation-review.js <reservation_id> <excused|unexcused>');
  process.exit(1);
}

const { data: reservation } = await db.from('reservations').select('*').eq('id', RESERVATION_ID).single();
console.log('Before:', reservation);
const { data: paymentsBefore } = await db.from('payments').select('*').eq('reservation_id', RESERVATION_ID);
console.log('Payments before:', paymentsBefore);

await applyCancellationReviewSideEffects(reservation, VERDICT === 'excused', null);

const { data: paymentsAfter } = await db.from('payments').select('*').or(`reservation_id.eq.${RESERVATION_ID},reservation_id.is.null`).order('created_at', { ascending: false }).limit(5);
console.log('Payments after (incl. any new floating credit):', paymentsAfter);
process.exit(0);
```

Run it against a real test reservation in a dev/staging Supabase project (never production data):
```bash
node server/scripts/verify-cancellation-review.js <a-real-confirmed-reservation-id> excused
```
Expected: the session's pending invoice (if any) is gone, or a paid one now shows `reservation_id: null` (a floating credit) in "Payments after."

```bash
node server/scripts/verify-cancellation-review.js <another-confirmed-reservation-id> unexcused
```
Expected: a new `no_show_fee` payment row (`amount: 500, status: 'pending'`) appears in "Payments after," and if that reservation had been paid, its invoice also shows up with `reservation_id: null`.

- [ ] **Step 4: Commit**

```bash
git add server/lib/noShow.js server/scripts/verify-cancellation-review.js
git commit -m "Add applyCancellationReviewSideEffects: excused credit/drop vs unexcused fee-always review outcomes"
```

---

### Task 10: Guardian portal — remove manual Speech/OT booking, add schedule view + request-cancellation UI

**Files:**
- Modify: `client/src/portals/parent/ParentPortal.jsx`

**Interfaces:**
- Consumes: `POST /api/reservations/:id/cancellation-requests` (Task 8), existing `GET /api/reservations/:clientId/schedules` (already used at line 545/577 for `childSchedules`), existing `sessionTypesFor(child)` (line 105).

- [ ] **Step 1: Remove Speech/OT from the bookable type list**

At `client/src/portals/parent/ParentPortal.jsx:105`, read the current `sessionTypesFor(child)` body first (it wasn't fully shown above — locate it) and change it so `'Occupational Therapy'` and `'Speech Therapy'` are never included in what it returns, e.g. if it currently looks like:
```js
function sessionTypesFor(child) {
  const types = [];
  if (!child) return types;
  if (child.therapy_type === 'OT' || child.therapy_type === 'Both') types.push('Occupational Therapy');
  if (child.therapy_type === 'Speech' || child.therapy_type === 'Both') types.push('Speech Therapy');
  if (/* initial assessment eligibility check */) types.push('Initial Assessment');
  return types;
}
```
change it to only ever return the Initial Assessment entry (and any make-up entry point already handled elsewhere — per this plan's stated assumption, guardians no longer see a make-up option either):
```js
function sessionTypesFor(child) {
  const types = [];
  if (!child) return types;
  if (/* initial assessment eligibility check, keep whatever this already was */) types.push('Initial Assessment');
  return types;
}
```
Keep whatever the exact Initial Assessment eligibility condition already was — only delete the two `push('Occupational Therapy'/'Speech Therapy')` lines.

- [ ] **Step 2: Remove the recurring "quick book" UI**

Delete (or guard permanently `false`) the `quickBookCandidates`/`quickBookRecurring` call sites at lines 1024-1079 and their render block around lines 1702, 1752, 2571 — these fill an assigned schedule's upcoming slots, which is now automatic server-side (Task 3/5) and shouldn't be guardian-triggerable at all. Keep the functions' definitions removed entirely (dead code otherwise) once every call site referencing them is gone — search the file for `quickBook` to find every reference before deleting.

- [ ] **Step 3: Add the read-only schedule view**

The `childSchedules` state (populated at line 545/577 via `GET /reservations/:id/schedules`, already shaped as `[{ id, discipline, day_of_week, time_slot, therapist_name, status, sessions: [...] }]` per the server route in Task-independent existing code) already has everything needed — this step is purely additive rendering, not new data-fetching. Add a new section (e.g. inside the existing Booking page render, above wherever the type picker used to render Speech/OT options):

```jsx
{childSchedules.filter(s => s.status === 'active').length > 0 && (
  <div style={{ marginBottom: 20 }}>
    <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}>
      <i className="fa-solid fa-calendar-week" style={{ color: 'var(--color-primary)', marginRight: 7 }} />
      {activeChild?.full_name}'s Fixed Weekly Schedule
    </div>
    {childSchedules.filter(s => s.status === 'active').map(schedule => (
      <div key={schedule.id} style={{ padding: 14, borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>
          {schedule.discipline === 'OT' ? 'Occupational Therapy' : 'Speech Therapy'} — {DAY_NAMES[schedule.day_of_week]}s at {schedule.time_slot}
        </div>
        <div style={{ fontSize: 12, color: '#64748B', marginTop: 3 }}>with {schedule.therapist_name}</div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(schedule.sessions || []).filter(s => s.date >= todayStr() && ['confirmed', 'rescheduled'].includes(s.status)).map(session => (
            <div key={session.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5, padding: '6px 0', borderTop: '1px solid #E2E8F0' }}>
              <span>{occurrenceLabel(session.date)}</span>
              <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => openCancellationRequestModal(session)}>
                <i className="fa-solid fa-file-circle-question" style={{ marginRight: 5 }} />Request Cancellation
              </button>
            </div>
          ))}
        </div>
      </div>
    ))}
  </div>
)}
```
(`occurrenceLabel` and `DAY_NAMES`/`todayStr` — reuse whatever date-formatting helpers already exist in this file for the rest of the booking UI; if none is named exactly that, match the file's existing convention instead of introducing a new one.)

- [ ] **Step 4: Add the cancellation-request modal/form**

Add local state and handler near the other booking-related state:
```js
const [cancellationRequestSession, setCancellationRequestSession] = useState(null); // the session object, or null when closed
const [cancellationFile, setCancellationFile] = useState(null);
const [cancellationNote, setCancellationNote] = useState('');
const [submittingCancellationRequest, setSubmittingCancellationRequest] = useState(false);

function openCancellationRequestModal(session) {
  setCancellationRequestSession(session);
  setCancellationFile(null);
  setCancellationNote('');
}

async function submitCancellationRequest() {
  if (!cancellationRequestSession || !cancellationFile) return;
  setSubmittingCancellationRequest(true);
  try {
    const formData = new FormData();
    formData.append('file', cancellationFile);
    formData.append('note', cancellationNote);
    const res = await fetch('/api/reservations/' + cancellationRequestSession.id + '/cancellation-requests', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + getToken() },
      body: formData
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Failed to submit request');
    toast('Cancellation request submitted for review', 'fa-circle-check');
    setCancellationRequestSession(null);
  } catch (err) {
    toast(err.message, 'fa-triangle-exclamation');
  } finally {
    setSubmittingCancellationRequest(false);
  }
}
```
Render, near the file's other conditionally-rendered modals:
```jsx
{cancellationRequestSession && (
  <Modal title={'Request Cancellation: ' + occurrenceLabel(cancellationRequestSession.date)} onClose={() => setCancellationRequestSession(null)} width={480}>
    <div style={{ fontSize: 12.5, color: '#64748B', marginBottom: 12 }}>
      Attach proof (e.g. a medical certificate) for staff/admin to review. If excused, no fee applies and any payment already made is applied to your next session. If not excused, a no-show fee will apply.
    </div>
    <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setCancellationFile(e.target.files?.[0] || null)} style={{ marginBottom: 10 }} />
    <textarea className="form-input" placeholder="Optional note" value={cancellationNote} onChange={e => setCancellationNote(e.target.value)} style={{ width: '100%', minHeight: 70, marginBottom: 14 }} />
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button className="btn-secondary" onClick={() => setCancellationRequestSession(null)}>Cancel</button>
      <button className="btn-primary" disabled={!cancellationFile || submittingCancellationRequest} onClick={submitCancellationRequest}>
        {submittingCancellationRequest ? 'Submitting…' : 'Submit Request'}
      </button>
    </div>
  </Modal>
)}
```

- [ ] **Step 5: Manual verification**

Start the client dev server, log in as a guardian whose child has an active Speech or OT fixed schedule. Confirm:
1. The booking type picker no longer offers Occupational Therapy or Speech Therapy, only Initial Assessment.
2. The new "Fixed Weekly Schedule" section lists the assigned slot and its upcoming confirmed occurrences.
3. Clicking "Request Cancellation" on an occurrence, attaching a file, and submitting shows the success toast and closes the modal.
4. Confirm via `GET /api/reservations/cancellation-requests` (or the staff UI once Task 11 lands) that the request now exists with `status: 'pending'`.

- [ ] **Step 6: Commit**

```bash
git add client/src/portals/parent/ParentPortal.jsx
git commit -m "Remove guardian manual Speech/OT booking, add read-only schedule view and cancellation-request flow"
```

---

### Task 11: Staff/admin cancellation-request review UI

**Files:**
- Modify: `client/src/portals/admin/pages/Reservations.jsx`

**Interfaces:**
- Consumes: `GET /api/reservations/cancellation-requests?status=pending`, `GET /api/reservations/cancellation-requests/:id/attachment`, `PUT /api/reservations/cancellation-requests/:id/review` (Task 8).

- [ ] **Step 1: Add a tab/section**

`Reservations.jsx` already renders staff/admin via a shared component (per the survey, both `AdminPortal` and `StaffPortal` render this same file with a `role` prop). Find its existing tab-switching pattern (search for how it currently switches between, e.g., a calendar view and a waitlist view) and add a new tab following that exact pattern, e.g.:

```jsx
const [activeTab, setActiveTab] = useState('calendar'); // existing state, just adding a new value below
// ...
<button className={activeTab === 'cancellation-requests' ? 'tab-active' : 'tab'} onClick={() => setActiveTab('cancellation-requests')}>
  Cancellation Requests {pendingRequestCount > 0 && <span className="badge">{pendingRequestCount}</span>}
</button>
```
(Match whatever the existing tab button markup/className actually is in this file — don't invent a new `tab`/`tab-active` class name if the file already has one.)

- [ ] **Step 2: Fetch + list pending requests**

```js
const [cancellationRequests, setCancellationRequests] = useState([]);
const [loadingCancellationRequests, setLoadingCancellationRequests] = useState(false);

async function fetchCancellationRequests() {
  setLoadingCancellationRequests(true);
  try {
    const data = await api('/reservations/cancellation-requests?status=pending');
    setCancellationRequests(data || []);
  } catch (e) {
    toast(e.message, 'fa-triangle-exclamation');
  } finally {
    setLoadingCancellationRequests(false);
  }
}

useEffect(() => {
  if (activeTab === 'cancellation-requests') fetchCancellationRequests();
}, [activeTab]);
```

Render:
```jsx
{activeTab === 'cancellation-requests' && (
  <div>
    {loadingCancellationRequests ? (
      <div style={{ padding: 20, color: '#94A3B8' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading…</div>
    ) : !cancellationRequests.length ? (
      <div style={{ padding: 20, color: '#94A3B8' }}>No pending cancellation requests.</div>
    ) : cancellationRequests.map(req => (
      <div key={req.id} style={{ padding: 14, borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{req.clients?.full_name}</div>
        <div style={{ fontSize: 12, color: '#64748B', marginTop: 3 }}>
          {req.reservations?.session_type} · {req.reservations?.date} at {req.reservations?.time_slot} with {req.reservations?.therapist_name}
        </div>
        {req.note && <div style={{ fontSize: 12, color: '#334155', marginTop: 6, fontStyle: 'italic' }}>"{req.note}"</div>}
        <div style={{ marginTop: 8 }}>
          <a href="#" onClick={async e => { e.preventDefault(); const { url } = await api('/reservations/cancellation-requests/' + req.id + '/attachment'); window.open(url, '_blank'); }} style={{ fontSize: 12, color: 'var(--color-primary)' }}>
            <i className="fa-solid fa-paperclip" style={{ marginRight: 5 }} />View attachment
          </a>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--color-success)', fontSize: 12, fontWeight: 600, color: '#fff' }} onClick={() => reviewCancellationRequest(req.id, 'excused')}>
            <i className="fa-solid fa-circle-check" style={{ marginRight: 5 }} />Excused Cancellation
          </button>
          <button style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12, fontWeight: 600, color: '#fff' }} onClick={() => reviewCancellationRequest(req.id, 'unexcused')}>
            <i className="fa-solid fa-user-slash" style={{ marginRight: 5 }} />Unexcused Cancellation
          </button>
        </div>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 3: Review action**

```js
const [reviewingId, setReviewingId] = useState(null);
async function reviewCancellationRequest(id, verdict) {
  setReviewingId(id);
  try {
    await api('/reservations/cancellation-requests/' + id + '/review', { method: 'PUT', body: { verdict } });
    toast(verdict === 'excused' ? 'Marked excused' : 'Marked unexcused, no-show fee applied', 'fa-circle-check');
    fetchCancellationRequests();
  } catch (e) {
    toast(e.message, 'fa-triangle-exclamation');
  } finally {
    setReviewingId(null);
  }
}
```
(Match the exact signature of this file's existing `api()` helper for a `PUT` with a JSON body — check an existing `PUT` call already in this file, e.g. the reschedule/no-show handlers, and copy its exact call shape rather than guessing.)

- [ ] **Step 4: Manual verification**

As staff or admin, open the new Cancellation Requests tab. Confirm the request submitted in Task 10's verification appears with the correct client/session details, "View attachment" opens the file, and clicking "Excused Cancellation" (or "Unexcused Cancellation") removes it from the pending list and produces the payments-side effects verified in Task 9's script.

- [ ] **Step 5: Commit**

```bash
git add client/src/portals/admin/pages/Reservations.jsx
git commit -m "Add staff/admin cancellation-request review tab"
```

---

### Task 12: Restrict the Reschedule button to Initial Assessment and make-up sessions

**Files:**
- Modify: `client/src/portals/admin/pages/reservations/SlotActionsModal.jsx:186`

**Interfaces:**
- Consumes: existing `isLockedToSchedule` (line 81) — already exactly `!!bk?.recurring_schedule_id && !bk?.is_makeup`, i.e. true only for a fixed-schedule Speech/OT occurrence.

- [ ] **Step 1: Change the render condition**

Change:
```jsx
        {canCancel && (
        <div style={{ padding: 14, borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}><i className="fa-solid fa-arrows-rotate" style={{ color: 'var(--color-primary)', marginRight: 7 }} />Reschedule to a different date &amp; time</div>
```
to:
```jsx
        {canCancel && !isLockedToSchedule && (
        <div style={{ padding: 14, borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}><i className="fa-solid fa-arrows-rotate" style={{ color: 'var(--color-primary)', marginRight: 7 }} />Reschedule to a different date &amp; time</div>
```
This removes the Reschedule block entirely for a fixed Speech/OT occurrence (which now goes through the cancellation-request flow instead, Tasks 8-11), while leaving it exactly as-is for Initial Assessment and make-up sessions (`isLockedToSchedule` is false for both, unchanged behavior). Everything inside the block that specifically branched on `isLockedToSchedule` (lines 189-207) is now dead code reachable only when it's false, i.e. `homeSchedule` is always null in the surviving render path — leave it, since `isLockedToSchedule && homeSchedule` conditions already correctly no-op, no further edit needed.

- [ ] **Step 2: Verify**

Run: `node --check` doesn't apply to JSX; instead start the client dev server and open the Manage Booking modal for (a) a fixed Speech/OT occurrence — confirm the Reschedule section is gone, only Cancel Booking (if applicable) remains — and (b) an Initial Assessment or make-up booking — confirm Reschedule still appears and works exactly as before.

- [ ] **Step 3: Commit**

```bash
git add client/src/portals/admin/pages/reservations/SlotActionsModal.jsx
git commit -m "Restrict Reschedule to Initial Assessment and make-up sessions"
```

---

### Task 13: Discharge + make-up credit — verify existing behavior covers the spec, no new code

**Files:** none modified — verification only.

- [ ] **Step 1: Confirm discharge already handles indefinite slots**

Read `server/lib/recurringSchedules.js`'s `cancelFutureReservationsForDischarge` (queries `.gt('date', todayPH())` with no upper bound) — this already sweeps every future confirmed/rescheduled/awaiting_payment reservation for the schedule regardless of how far out it is, so once Task 3/5 make that set "up to 14 days out" instead of "however many the guardian manually booked," discharge needs zero code changes. Manually verify: assign a schedule (auto-fills ~2 confirmed sessions per Task 5), then discharge it from Client Records. Confirm both auto-filled sessions flip to `cancelled` and any paid one shows up as a floating credit.

- [ ] **Step 2: Confirm make-up credit-application already works**

Read `server/routes/reservations.js`'s `ensurePaymentForReservation` (lines 123-189) — it already auto-matches the oldest floating credit by client + fee_type + amount before ever creating a fresh invoice, for ANY new reservation including a staff-booked make-up session (`POST /reservations` with `is_makeup: true` calls this same function, see lines 973-989). No new code is needed for "use a credit to book a make-up session." Manually verify: after Task 9's verification script produces a floating credit for a test client, have staff book that same client a make-up session at the matching discipline's rate, and confirm the new reservation's invoice shows `status: 'paid'` immediately (the credit auto-attached) rather than a fresh `pending` invoice.

- [ ] **Step 3: No commit** (no files changed).

---

## Self-Review

**Spec coverage:**
- Fixed schedule assignment auto-fills confirmed/unpaid-or-credited sessions indefinitely (rolling window) — Tasks 3, 4, 5. ✓
- Initial assessment untouched — never referenced by any modified auto-fill/removal code path (Tasks 3, 5, 8, 10 all gate on `recurring_schedule_id`/discipline). ✓
- Discharge removes confirmed slots, paid ones become credit — Task 13 confirms existing `dischargeSchedule`/`cancelFutureReservationsForDischarge` already covers this once Tasks 3/5 land. ✓
- Advance payment capped to ~2 sessions/current week — Global Constraints + Task 7 (same rolling window as the horizon, confirmed via AskUserQuestion answer). ✓
- Guardian can't manually book Speech/OT — Task 10 Steps 1-2. ✓
- Guardian read-only schedule view + cancellation request with attachment — Task 10 Steps 3-4. ✓
- Staff/admin review, excused/unexcused buttons — Task 11. ✓
- Unexcused → no-show fee, replaces unpaid charge, still credits if paid — Task 9. ✓
- Credit usable for next session (auto) or make-up (staff-applied) — Task 13 Step 2 confirms existing `ensurePaymentForReservation` already does both. ✓
- Reschedule restricted to Initial Assessment/make-up — Task 12. ✓
- Holiday/closure ahead of time → skip generation; late → auto-excuse — Task 3 (skip) + Task 6 (auto-excuse). ✓
- Therapist unavailability on a given day/slot — Task 3's `worksOn`/`isLunchHour` check against the therapist's current shift at fill time. ✓

**Placeholder scan:** no TBD/TODO, no "add appropriate X," every step shows real code or an exact command. Task 7 Step 3 says "adjust variable names to match" because the exact local variable name inside the existing `/checkout/combined` handler wasn't captured verbatim during the codebase survey — this is a real, bounded ambiguity (which existing variable holds the joined reservation), not a placeholder for undesigned logic; the executor reads the ~10 surrounding lines already in the file to resolve it.

**Type/interface consistency:** `fillReservationsForSchedule(schedule, actorId)` signature matches across Tasks 3, 4, 5. `applyCancellationReviewSideEffects(reservation, excused, actorId)` matches across Tasks 8 and 9. `FILL_HORIZON_DAYS` exported from `recurringFill.js` in Task 3, imported unchanged in Task 7. `cancellation_requests` column names (Task 1) match every query in Tasks 8, 9, 11 exactly (`attachment_path`, `attachment_bucket`, `reservation_id`, `status`, `reviewed_by`, `reviewed_at`, `review_note`, `note`).

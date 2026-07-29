import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { api } from '../../../api.js';
import { sanitizeNameInput, hasInvalidNameChars, INVALID_NAME_MSG } from '../../../nameInput.js';

/** Live-filters a name field and toggles its sibling `${noteId}` warning div. */
function onNameInput(noteId) {
  return e => {
    const note = document.getElementById(noteId);
    if (note) note.style.display = hasInvalidNameChars(e.target.value) ? 'block' : 'none';
    e.target.value = sanitizeNameInput(e.target.value);
  };
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), independent of browser timezone. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * How many consecutive absences (no-show or cancelled) this schedule currently
 * has, most-recent-first, stopping at the first actually-attended session or
 * a change in excused/unexcused type, capped at 3 (the MOA policy only ever
 * looks at the most recent 3, see checkConsecutiveAbsences server-side).
 * Purely a read-only monitoring view, staff can see a streak building up
 * BEFORE it hits 3 and triggers a retainer fee/forfeiture, not just after
 * the fact. Returns null when there's no active streak.
 *
 * Mirrors checkConsecutiveAbsences server-side exactly: excludes make-up
 * sessions (booked on a different day by design, they'd otherwise get
 * mistaken for one of the schedule's own weekly misses), excludes an
 * administrative_cancel row (the schedule itself was edited/discharged, not
 * a real miss - editing a schedule can cancel 2+ already-generated future
 * occurrences at once, which would otherwise misread as 2-3 real consecutive
 * absences right after a routine day/time change), treats a past
 * confirmed/rescheduled row nobody explicitly resolved as attended (same as
 * everywhere else in the app), and requires each absence to be exactly 7
 * days apart from the next - a week the family never booked at all leaves no
 * row, and silently skipping past that gap would let non-consecutive misses
 * masquerade as one real streak.
 */
function computeAttendanceStreak(schedule) {
  const today = todayPH();
  const resolved = (schedule.reservations || [])
    .filter(r => !r.is_makeup && !r.administrative_cancel && (
      r.status === 'completed' || r.status === 'no_show' || r.status === 'cancelled'
      || (['confirmed', 'rescheduled'].includes(r.status) && r.date < today)
    ))
    .slice().sort((a, b) => b.date.localeCompare(a.date));
  let count = 0;
  let excused = null;
  let prevDate = null;
  for (const r of resolved) {
    if (r.status !== 'no_show' && r.status !== 'cancelled') break; // attended (or effectively attended)
    if (prevDate !== null) {
      const gapDays = Math.round((Date.parse(prevDate) - Date.parse(r.date)) / 86400000);
      if (gapDays !== 7) break; // an unbooked week in between, not a real consecutive streak
    }
    const isExcused = r.no_show_excused === true;
    if (excused === null) excused = isExcused;
    else if (excused !== isExcused) break;
    count++;
    prevDate = r.date;
    if (count >= 3) break;
  }
  return count > 0 ? { count, excused } : null;
}

function hourLabel(h) {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return hr + ':00 ' + (h >= 12 ? 'PM' : 'AM');
}
/** JS weekday (0=Sunday..6=Saturday) to a therapist shift's work_days index (Mon=0..Sun=6). */
function toWorkDaysIndex(jsDay) { return (jsDay + 6) % 7; }

/** The next real calendar date (>= tomorrow) that falls on the given JS weekday
 *  (0=Sunday..6=Saturday), same "starts tomorrow" rule the server's own
 *  assign-schedule route uses to generate the batch's actual dates. Used here
 *  only to preview real availability, the server re-validates every date for real. */
function nextOccurrenceDate(jsDay) {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== jsDay) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Every time_slot already spoken for on this weekday for this therapist, from
 * three independent sources, split into three kinds:
 *
 * `blocked` (can't be picked at all, no waitlist makes sense): the
 * therapist's own real booked shift capacity (GET /reservations/slots) is
 * full.
 *
 * `waitlistable` (still pickable): ANOTHER active recurring schedule already
 * pinned to that exact day/time/therapist (GET /recurring-schedules/taken, a
 * schedule is a standing pin, not a booked reservation, so the slots endpoint
 * alone can't see it) - someone else's slot, so joining their waitlist is a
 * real option.
 *
 * `selfConflict` (a hard "Schedule Conflict", never a waitlist candidate):
 * this SAME client already has another active schedule of the SAME
 * discipline at that exact day/time. Two different therapists of the same
 * discipline can never both hold this client at once - that's not "someone
 * else's slot to wait for", it's just not a valid combination, so it's kept
 * in its own bucket instead of lumped into `blocked` (see ScheduleTimePicker,
 * which labels it distinctly). A DIFFERENT discipline at the same day/time is
 * fine (e.g. a Combined client's OT and Speech running concurrently), so this
 * only ever looks at schedules matching `discipline`.
 *
 * All three stay selectable in the picker (informational labels only, never
 * `disabled`) so the option list doesn't silently shrink, but only `blocked`/
 * `waitlistable` ever offer "Add to Waitlist Instead" - see occupiedPick in
 * ScheduleRow/PendingSlotPicker.
 *
 * `excludeScheduleId` lets an edit-in-place exclude the schedule being edited
 * from all three checks, otherwise it would flag itself as a conflict.
 *
 * `excludeClientId` (edit-in-place only) additionally excludes that client's
 * OWN existing bookings from the real shift-capacity check (`blocked`) -
 * without it, the client's own already-generated session on that exact
 * date/hour/therapist (see recurringFill.js) fills the one slot of capacity
 * and makes the schedule they're currently on look "occupied" to themselves.
 */
function useTakenTimes(therapistName, dayOfWeek, discipline, allActiveSchedules, excludeScheduleId, excludeClientId) {
  const [shiftTaken, setShiftTaken] = useState(new Set());
  useEffect(() => {
    if (!therapistName || dayOfWeek === '') { setShiftTaken(new Set()); return; }
    let cancelled = false;
    const date = nextOccurrenceDate(Number(dayOfWeek));
    const qs = 'date=' + date + '&therapist_name=' + encodeURIComponent(therapistName)
      + (excludeClientId ? '&exclude_client_id=' + excludeClientId : '');
    api('/reservations/slots?' + qs)
      .then(slots => { if (!cancelled) setShiftTaken(new Set((slots || []).filter(s => (s.available ?? 0) <= 0).map(s => s.time_slot))); })
      .catch(() => { if (!cancelled) setShiftTaken(new Set()); });
    return () => { cancelled = true; };
  }, [therapistName, dayOfWeek, excludeClientId]);

  const [scheduleTaken, setScheduleTaken] = useState(new Set());
  useEffect(() => {
    if (!therapistName || dayOfWeek === '') { setScheduleTaken(new Set()); return; }
    let cancelled = false;
    const qs = 'day_of_week=' + dayOfWeek + '&therapist_name=' + encodeURIComponent(therapistName)
      + (excludeScheduleId ? '&exclude_schedule_id=' + excludeScheduleId : '');
    api('/reservations/recurring-schedules/taken?' + qs)
      .then(list => { if (!cancelled) setScheduleTaken(new Set((list || []).map(s => s.time_slot))); })
      .catch(() => { if (!cancelled) setScheduleTaken(new Set()); });
    return () => { cancelled = true; };
  }, [therapistName, dayOfWeek, excludeScheduleId]);

  const clientTaken = dayOfWeek === ''
    ? new Set()
    : new Set((allActiveSchedules || [])
        .filter(s => s.discipline === discipline && s.day_of_week === Number(dayOfWeek) && s.id !== excludeScheduleId)
        .map(s => s.time_slot));

  return { blocked: shiftTaken, waitlistable: scheduleTaken, selfConflict: clientTaken };
}

/** Shared Therapist/Day/Time picker markup for both the "assign new" form
 *  and a schedule's inline edit form, so their behavior (and the taken-time
 *  graying) never drifts apart. `takenTimes` is the { blocked, waitlistable,
 *  selfConflict } shape from useTakenTimes. */
function ScheduleTimePicker({ therapistName, setTherapistName, dayOfWeek, setDayOfWeek, timeSlot, setTimeSlot, roleTherapists, takenTimes }) {
  const selectedTherapist = roleTherapists.find(t => t.name === therapistName);
  const worksChosenDay = selectedTherapist && dayOfWeek !== ''
    ? selectedTherapist.work_days[toWorkDaysIndex(Number(dayOfWeek))] !== false
    : false;
  const timeOptions = [];
  if (selectedTherapist && worksChosenDay) {
    for (let h = selectedTherapist.start_hour; h < selectedTherapist.end_hour; h++) {
      const onLunch = selectedTherapist.lunch_start_hour != null && selectedTherapist.lunch_end_hour != null
        && h >= selectedTherapist.lunch_start_hour && h < selectedTherapist.lunch_end_hour;
      if (!onLunch) timeOptions.push(hourLabel(h));
    }
  }
  return (
    <>
      <div>
        <label className="form-label">Therapist</label>
        <select className="form-select" value={therapistName} onChange={e => { setTherapistName(e.target.value); setDayOfWeek(''); setTimeSlot(''); }}>
          <option value="">- Select -</option>
          {roleTherapists.map(t => <option key={t.therapist_id} value={t.name}>{t.name}</option>)}
        </select>
      </div>
      <div>
        <label className="form-label">Day of the Week</label>
        <select className="form-select" value={dayOfWeek} onChange={e => { setDayOfWeek(e.target.value); setTimeSlot(''); }} disabled={!therapistName}>
          <option value="">- Select -</option>
          {WEEKDAY_NAMES.map((name, idx) => {
            // Days the clinic doesn't run for this therapist at all (e.g. a
            // closed Sunday nobody opted into) are left out entirely instead
            // of listed and then rejected below, there's nothing bookable
            // there to pick in the first place.
            if (selectedTherapist && selectedTherapist.work_days[toWorkDaysIndex(idx)] === false) return null;
            return <option key={idx} value={idx}>{name}</option>;
          })}
        </select>
      </div>
      <div>
        <label className="form-label">Time Slot</label>
        {!therapistName || dayOfWeek === '' ? (
          <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC', fontSize: 12 }}>Pick therapist &amp; day first</div>
        ) : !worksChosenDay ? (
          <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#DC2626', background: '#FEF2F2', fontSize: 12 }}>Not on shift {WEEKDAY_NAMES[dayOfWeek]}s</div>
        ) : (
          <select className="form-select" value={timeSlot} onChange={e => setTimeSlot(e.target.value)} style={timeSlot && takenTimes.selfConflict.has(timeSlot) ? { color: '#DC2626' } : timeSlot && (takenTimes.blocked.has(timeSlot) || takenTimes.waitlistable.has(timeSlot)) ? { color: '#B45309' } : undefined}>
            <option value="">- Select -</option>
            {timeOptions.map(t => {
              // None of the three kinds disable the option, staff can still
              // pick an occupied slot on purpose - `blocked`/`waitlistable`
              // get offered "Add to Waitlist Instead" once the assign/save
              // attempt confirms it's really taken; `selfConflict` never does
              // (there's no one else's waitlist to join for double-booking
              // this same client), it's labeled as a flat conflict instead.
              const conflict = takenTimes.selfConflict.has(t);
              const occupied = !conflict && (takenTimes.blocked.has(t) || takenTimes.waitlistable.has(t));
              return (
                // Every option sets its own color explicitly, an option with
                // no color of its own would otherwise inherit the <select>'s
                // (set below to reflect the currently chosen value), turning
                // the WHOLE open list that color instead of just this one row.
                <option key={t} value={t} style={{ color: conflict ? '#DC2626' : occupied ? '#B45309' : '#0F172A' }}>
                  {t}{conflict ? ' (schedule conflict)' : occupied ? ' (occupied, pick to join waitlist)' : ''}
                </option>
              );
            })}
          </select>
        )}
      </div>
    </>
  );
}

/**
 * One active schedule's row: read-only summary + Edit/Discharge by default,
 * switches to an inline edit form (same Therapist/Day/Time picker as
 * assigning a new one, pre-filled with its current values) when Edit is
 * clicked. Editing in place keeps its own id/sessions_completed history
 * intact, unlike discharge-then-reassign, which would reset the count and
 * always ping the waitlist even for something as small as a typo fix, this
 * only notifies the waitlist for the OLD slot if it actually changes.
 */
function ScheduleRow({ clientId, discipline, disciplineLabel, allTherapists, schedule, allActiveSchedules, onChanged, toast }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [therapistName, setTherapistName] = useState(schedule.therapist_name);
  const [dayOfWeek, setDayOfWeek] = useState(String(schedule.day_of_week));
  const [timeSlot, setTimeSlot] = useState(schedule.time_slot);

  // Same role-matching pool as assigning a new schedule, except this
  // schedule's OWN current therapist stays selectable (it's not "taken" from
  // its own point of view), only OTHER schedules' therapists are excluded.
  const takenTherapistNames = new Set((allActiveSchedules || []).filter(s => s.id !== schedule.id).map(s => s.therapist_name));
  const roleTherapists = (allTherapists || []).filter(t => t.role === (discipline === 'OT' ? 'ot' : 'speech') && (!takenTherapistNames.has(t.name) || t.name === schedule.therapist_name));
  const takenTimes = useTakenTimes(editing ? therapistName : '', editing ? dayOfWeek : '', discipline, allActiveSchedules, schedule.id, clientId);

  // Set when save() hits a slot another client already holds (server-confirmed),
  // offers "Add to Waitlist Instead" instead of a dead-end error.
  const [slotConflict, setSlotConflict] = useState(null);

  // Shows the waitlist button the moment an occupied slot is PICKED, not only
  // after clicking Save and getting a conflict back, using the same
  // blocked/waitlistable info the picker already labels "(occupied)" with.
  // selfConflict (this client's own same-discipline schedule already there)
  // is deliberately excluded - there's no one else's waitlist to join for
  // double-booking yourself, see scheduleConflictPick below instead.
  const occupiedPick = therapistName && dayOfWeek !== '' && timeSlot
    && (takenTimes.blocked.has(timeSlot) || takenTimes.waitlistable.has(timeSlot));
  const waitlistTarget = slotConflict || (occupiedPick ? { therapistName, dayOfWeek: Number(dayOfWeek), timeSlot } : null);
  const scheduleConflictPick = therapistName && dayOfWeek !== '' && timeSlot && takenTimes.selfConflict.has(timeSlot);

  function startEdit() {
    setTherapistName(schedule.therapist_name);
    setDayOfWeek(String(schedule.day_of_week));
    setTimeSlot(schedule.time_slot);
    setSlotConflict(null);
    setEditing(true);
  }

  async function save() {
    if (!therapistName || dayOfWeek === '' || !timeSlot) return toast('Fill in therapist, day, and time', 'fa-triangle-exclamation');
    if (scheduleConflictPick) return toast(`Schedule conflict: this client already has a ${disciplineLabel} schedule ${WEEKDAY_NAMES[dayOfWeek]}s at ${timeSlot}.`, 'fa-triangle-exclamation');
    setSlotConflict(null);
    setBusy(true);
    try {
      const result = await api('/reservations/recurring-schedules/' + schedule.id, {
        method: 'PUT',
        body: { day_of_week: Number(dayOfWeek), time_slot: timeSlot, therapist_name: therapistName }
      });
      const reconciledNote = result.reconciledCount ? `, ${result.reconciledCount} old-day/time session${result.reconciledCount > 1 ? 's' : ''} cancelled and credited` : '';
      toast(
        result.notifiedWaitlistClient
          ? `${disciplineLabel} schedule updated${reconciledNote}, ${result.notifiedWaitlistClient} (waitlisted for the old slot) was notified`
          : `${disciplineLabel} schedule updated${reconciledNote}`,
        'fa-check'
      );
      setEditing(false);
      onChanged();
    } catch (e) {
      toast(e.message || 'Failed to update schedule', 'fa-triangle-exclamation');
      if (e.data?.slotTaken) setSlotConflict({ therapistName, dayOfWeek: Number(dayOfWeek), timeSlot });
    } finally {
      setBusy(false);
    }
  }

  async function addToWaitlist() {
    if (!waitlistTarget) return;
    setBusy(true);
    try {
      await api('/reservations/schedule-waitlist', {
        method: 'POST',
        body: { discipline, therapist_name: waitlistTarget.therapistName, day_of_week: waitlistTarget.dayOfWeek, time_slot: waitlistTarget.timeSlot, client_id: clientId }
      });
      toast('Added to the waitlist for that slot', 'fa-check');
      setSlotConflict(null);
    } catch (e) {
      toast(e.message || 'Failed to add to waitlist', 'fa-triangle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  async function discharge() {
    setBusy(true);
    try {
      const result = await api('/reservations/recurring-schedules/' + schedule.id, { method: 'PUT', body: { status: 'discharged' } });
      const cancelledNote = result.cancelledCount ? `, ${result.cancelledCount} future session${result.cancelledCount > 1 ? 's' : ''} cancelled` : '';
      toast(
        result.notifiedWaitlistClient
          ? `${disciplineLabel} schedule discharged${cancelledNote}, ${result.notifiedWaitlistClient} (next on the waitlist) was notified`
          : `${disciplineLabel} schedule discharged${cancelledNote}`,
        'fa-check'
      );
      onChanged();
    } catch (e) {
      toast(e.message || 'Failed to discharge schedule', 'fa-triangle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    const streak = computeAttendanceStreak(schedule);
    return (
      <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#0F172A' }}>
            {WEEKDAY_NAMES[schedule.day_of_week]}s {schedule.time_slot} with {schedule.therapist_name}{schedule.sessions_completed ? ` · ${schedule.sessions_completed} completed` : ''}
          </div>
          <button className="btn-secondary" disabled={busy} onClick={startEdit} style={{ fontSize: 11, padding: '5px 9px', flexShrink: 0 }}>Edit</button>
          <button className="btn-secondary" disabled={busy} onClick={discharge} style={{ fontSize: 11, padding: '5px 9px', flexShrink: 0 }}>Discharge</button>
        </div>
        {streak && (
          <div style={{ fontSize: 11, marginTop: 6, padding: '5px 8px', borderRadius: 6, background: streak.count >= 3 ? '#FEE2E2' : '#FFFBEB', color: streak.count >= 3 ? '#991B1B' : '#92400E' }}>
            <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 5 }} />
            {streak.count} consecutive {streak.excused ? 'excused' : 'unexcused'} absence{streak.count > 1 ? 's' : ''}
            {streak.count < 3 && ` — ${3 - streak.count} more triggers ${streak.excused ? 'a retainer fee' : 'slot forfeiture'}`}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ border: '1px solid #93C5FD', borderRadius: 8, padding: '10px', background: '#F8FAFC' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
        <ScheduleTimePicker
          therapistName={therapistName} setTherapistName={setTherapistName}
          dayOfWeek={dayOfWeek} setDayOfWeek={setDayOfWeek}
          timeSlot={timeSlot} setTimeSlot={setTimeSlot}
          roleTherapists={roleTherapists} takenTimes={takenTimes}
        />
      </div>
      {scheduleConflictPick && (
        <div style={{ fontSize: 11.5, color: '#DC2626', marginBottom: 8 }}>
          <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 5 }} />
          Schedule conflict: this client already has a {disciplineLabel} schedule {WEEKDAY_NAMES[dayOfWeek]}s at {timeSlot}. Pick a different day or time.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-primary" style={{ fontSize: 11.5, padding: '6px 12px' }} disabled={busy || scheduleConflictPick} onClick={save}>
          <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-check')} style={{ marginRight: 5 }} />{busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-secondary" style={{ fontSize: 11.5, padding: '6px 12px' }} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        {waitlistTarget && (
          <button className="btn-secondary" style={{ fontSize: 11.5, padding: '6px 12px' }} disabled={busy} onClick={addToWaitlist}>
            <i className="fa-solid fa-user-clock" style={{ marginRight: 5 }} />Add to Waitlist Instead
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One discipline's therapy-schedule status, inline inside Edit Client Profile
 * instead of a separate "Assign Schedule" action, assigning a therapist to a
 * discipline and fixing their weekly day/time are the same real-world
 * decision, splitting them into two different UI entry points was just
 * redundant. There's no session count, nobody can predict how many a child
 * will need, the assignment just applies indefinitely until staff discharges
 * it. If a schedule already exists (active) this shows its read-only summary
 * + Discharge; otherwise it's the assignment form that creates one (see
 * POST .../assign-schedule).
 */
const EMPTY_SLOT = { therapistName: '', dayOfWeek: '', timeSlot: '', conflict: null };

/** Turns one discipline's filled (day + time picked) pending rows into the
 *  same `{ id, day_of_week, time_slot, therapist_name, discipline }` shape a
 *  real recurring_schedules row has, so a row's OTHER still-unsaved sibling
 *  rows (same discipline) can be merged straight into its own useTakenTimes
 *  conflict check alongside actually-committed schedules, see
 *  DisciplineScheduleSection below. */
function pendingAsSchedules(pendingSlots, disciplineLabel) {
  return pendingSlots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.dayOfWeek !== '' && s.timeSlot)
    .map(({ s, i }) => ({
      id: `pending-${disciplineLabel}-${i}`, day_of_week: Number(s.dayOfWeek), time_slot: s.timeSlot,
      therapist_name: s.therapistName, discipline: disciplineLabel
    }));
}

/**
 * One of the (possibly several) simultaneous therapist/day/time pickers shown
 * when a discipline is short more than one weekly session vs. its recommended
 * count, so staff fill in all of them before ever hitting Save Changes rather
 * than assigning one, saving, then finding out a second slot's now available.
 * Its own `useTakenTimes` call lives in its own component (not a loop inside
 * the parent) since hook call count must stay static per render - an array of
 * pickers whose length itself changes size can't share one hook slot.
 */
function PendingSlotPicker({ slot, onChange, roleTherapists, allActiveSchedules, discipline, clientId, disciplineLabel, toast, busy, setBusy }) {
  const { therapistName, dayOfWeek, timeSlot } = slot;
  // ScheduleTimePicker's therapist <select> fires setTherapistName then
  // immediately setDayOfWeek('') and setTimeSlot('') right after, to clear
  // the downstream fields (see its onChange below). Each setter here must go
  // through onChange as a functional update (patch against whatever the
  // PREVIOUS call in that same sequence just produced), never rebuilt from
  // this render's own `slot` closure - otherwise the 2nd/3rd calls would
  // overwrite the 1st call's therapist pick with stale, pre-pick data.
  const setTherapistName = v => onChange(() => ({ therapistName: v, dayOfWeek: '', timeSlot: '', conflict: null }));
  const setDayOfWeek = v => onChange(prev => ({ ...prev, dayOfWeek: v, timeSlot: '', conflict: null }));
  const setTimeSlot = v => onChange(prev => ({ ...prev, timeSlot: v, conflict: null }));

  const takenTimes = useTakenTimes(therapistName, dayOfWeek, discipline, allActiveSchedules, null);
  // selfConflict (this client's own same-discipline pick/schedule already at
  // this day/time) is excluded from occupiedPick - there's no one else's
  // waitlist to join for double-booking yourself, see scheduleConflictPick.
  const occupiedPick = therapistName && dayOfWeek !== '' && timeSlot
    && (takenTimes.blocked.has(timeSlot) || takenTimes.waitlistable.has(timeSlot));
  const waitlistTarget = slot.conflict || (occupiedPick ? { therapistName, dayOfWeek: Number(dayOfWeek), timeSlot } : null);
  const scheduleConflictPick = therapistName && dayOfWeek !== '' && timeSlot && takenTimes.selfConflict.has(timeSlot);

  async function addToWaitlist() {
    if (!waitlistTarget) return;
    setBusy(true);
    try {
      await api('/reservations/schedule-waitlist', {
        method: 'POST',
        body: { discipline, therapist_name: waitlistTarget.therapistName, day_of_week: waitlistTarget.dayOfWeek, time_slot: waitlistTarget.timeSlot, client_id: clientId }
      });
      toast('Added to the waitlist for that slot', 'fa-check');
      onChange(() => ({ ...EMPTY_SLOT }));
    } catch (e) {
      toast(e.message || 'Failed to add to waitlist', 'fa-triangle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, border: '1px solid #E2E8F0', borderRadius: 8, padding: 10, background: '#F8FAFC' }}>
      <ScheduleTimePicker
        therapistName={therapistName} setTherapistName={setTherapistName}
        dayOfWeek={dayOfWeek} setDayOfWeek={setDayOfWeek}
        timeSlot={timeSlot} setTimeSlot={setTimeSlot}
        roleTherapists={roleTherapists} takenTimes={takenTimes}
      />
      {scheduleConflictPick ? (
        <div style={{ gridColumn: '1/-1', fontSize: 11.5, color: '#DC2626' }}>
          <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 5 }} />
          Schedule conflict: this client already has a {disciplineLabel} schedule {WEEKDAY_NAMES[dayOfWeek]}s at {timeSlot}. Pick a different day or time.
        </div>
      ) : waitlistTarget && (
        <div style={{ gridColumn: '1/-1' }}>
          <button className="btn-secondary" style={{ fontSize: 12, padding: '7px 14px' }} disabled={busy} onClick={addToWaitlist}>
            <i className="fa-solid fa-user-clock" style={{ marginRight: 5 }} />Add to Waitlist Instead
          </button>
        </div>
      )}
    </div>
  );
}

const DisciplineScheduleSection = forwardRef(function DisciplineScheduleSection(
  { clientId, discipline, disciplineLabel, allTherapists, legacyAssigned, schedules, allActiveSchedules, recommended, onChanged, toast },
  ref
) {
  // Therapists already covering this discipline for this client are excluded,
  // 1 session per therapist per week, the same person can't hold a second slot.
  const takenTherapistNames = new Set(schedules.map(s => s.therapist_name));
  const roleTherapists = (allTherapists || []).filter(t => t.role === (discipline === 'OT' ? 'ot' : 'speech') && !takenTherapistNames.has(t.name));
  const atRecommendedCap = recommended != null && schedules.length >= recommended;
  const [busy, setBusy] = useState(false);

  // How many simultaneous picker rows to show: the actual remaining gap to
  // the recommended weekly count (so picking "2 or 3 per week" immediately
  // offers that many therapist slots at once, no intermediate Save Changes
  // needed between the 1st and 2nd), or just one open-ended row when no
  // recommendation is set (the old unlimited-add-one-at-a-time behavior).
  const slotsNeeded = recommended != null ? Math.max(0, recommended - schedules.length) : 1;
  const [pendingSlots, setPendingSlots] = useState(() => Array.from({ length: slotsNeeded }, () => ({ ...EMPTY_SLOT })));

  // Grows/shrinks the pending-row count from the end only as the recommended
  // dropdown changes or a schedule gets committed/discharged elsewhere, so
  // picks already entered in earlier rows are never disturbed.
  useEffect(() => {
    setPendingSlots(prev => {
      if (slotsNeeded === prev.length) return prev;
      if (slotsNeeded > prev.length) return [...prev, ...Array.from({ length: slotsNeeded - prev.length }, () => ({ ...EMPTY_SLOT }))];
      return prev.slice(0, slotsNeeded);
    });
  }, [slotsNeeded]);

  // `updater` is a function (prevSlot) => nextSlot, same shape as React's own
  // functional setState - each call composes against whatever the previous
  // call in the same event handler just produced (see PendingSlotPicker's
  // setTherapistName/setDayOfWeek/setTimeSlot), not a stale render-time value.
  function updateSlot(index, updater) {
    setPendingSlots(prev => prev.map((s, i) => i === index ? updater(s) : s));
  }

  /**
   * Exposed to the parent's single Save Changes button (no more standalone
   * "Assign ... Schedule" button per discipline, that was a redundant second
   * save action for what's really one edit to the client's profile). Commits
   * every fully-picked row (therapist + day + time), in order, so 2+
   * simultaneous assignments for a "2 or more per week" recommendation all
   * go in from one Save Changes click. A row left half-filled blocks the
   * whole save (same "fill it in or clear it" rule as a single row always
   * had); a failed row (e.g. a slot conflict) keeps its values and shows
   * "Add to Waitlist Instead" instead of being silently discarded, while
   * any other row that succeeded is still committed.
   * Returns true only if every fully-picked row committed successfully (or
   * there was nothing pending to commit); false keeps Save Changes from
   * closing the modal so staff can fix the failed row(s).
   */
  useImperativeHandle(ref, () => ({
    async commitPending() {
      const filled = pendingSlots.filter(s => s.therapistName && s.dayOfWeek !== '' && s.timeSlot);
      const empty = pendingSlots.filter(s => !s.therapistName && s.dayOfWeek === '' && !s.timeSlot);
      if (filled.length + empty.length !== pendingSlots.length) {
        toast(`Fill in therapist, day, and time for every ${disciplineLabel} row you started, or clear it to skip`, 'fa-triangle-exclamation');
        return false;
      }
      if (filled.length === 0) {
        // A discipline shown here means the client's Therapy Type calls for
        // it, so it needs an actual therapist/day/time on file, not just the
        // label. Block Save Changes until one is assigned, UNLESS a schedule
        // already covers it (nothing new needed) or there's truly no eligible
        // therapist to pick from at all (roleTherapists.length === 0, the
        // read-only "No other registered ... therapists available" state),
        // where requiring a pick would be a dead end with no way to satisfy it.
        if (schedules.length === 0 && roleTherapists.length > 0) {
          toast(`Assign a ${disciplineLabel} therapist, day, and time before saving, or change the Therapy Type above if this discipline isn't needed.`, 'fa-triangle-exclamation');
          return false;
        }
        return true;
      }
      // Two of these rows landing on the same day/time (necessarily two
      // different therapists, same discipline - the picker already excludes
      // reusing a therapist across rows) is never valid, checked here before
      // either one ever reaches the server so it's caught as a clear error
      // instead of the 2nd row's API call failing with a raw 409. A different
      // discipline at the same day/time is fine (e.g. concurrent OT + Speech
      // for a Combined client) and isn't checked here at all - see the
      // (discipline-scoped) selfConflict bucket in useTakenTimes for why.
      for (let a = 0; a < filled.length; a++) {
        for (let b = a + 1; b < filled.length; b++) {
          if (filled[a].dayOfWeek === filled[b].dayOfWeek && filled[a].timeSlot === filled[b].timeSlot) {
            toast(`Schedule conflict: two ${disciplineLabel} rows are both set to ${WEEKDAY_NAMES[filled[a].dayOfWeek]}s at ${filled[a].timeSlot}. Pick a different day or time for one of them.`, 'fa-triangle-exclamation');
            return false;
          }
        }
      }
      setBusy(true);
      const nextSlots = [...pendingSlots];
      let anySucceeded = false;
      let anyFailed = false;
      for (let i = 0; i < nextSlots.length; i++) {
        const s = nextSlots[i];
        if (!(s.therapistName && s.dayOfWeek !== '' && s.timeSlot)) continue;
        try {
          await api('/reservations/' + clientId + '/assign-schedule', {
            method: 'POST',
            body: { discipline, therapist_name: s.therapistName, day_of_week: Number(s.dayOfWeek), time_slot: s.timeSlot }
          });
          toast(`${disciplineLabel} schedule assigned: ${WEEKDAY_NAMES[s.dayOfWeek]}s at ${s.timeSlot} with ${s.therapistName}`, 'fa-check');
          nextSlots[i] = { ...EMPTY_SLOT };
          anySucceeded = true;
        } catch (e) {
          toast(e.message || `Failed to assign ${disciplineLabel} schedule with ${s.therapistName}`, 'fa-triangle-exclamation');
          nextSlots[i] = { ...s, conflict: e.data?.slotTaken ? { therapistName: s.therapistName, dayOfWeek: Number(s.dayOfWeek), timeSlot: s.timeSlot } : null };
          anyFailed = true;
        }
      }
      setPendingSlots(nextSlots);
      setBusy(false);
      if (anySucceeded) onChanged();
      return !anyFailed;
    }
  }), [pendingSlots, clientId, discipline, disciplineLabel, onChanged, toast, schedules.length, roleTherapists.length]);

  return (
    <div style={{ gridColumn: '1/-1', border: '1px dashed #CBD5E1', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0F172A', marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{disciplineLabel}{recommended != null && <span style={{ fontWeight: 400, color: '#64748B' }}> · {schedules.length} of {recommended} weekly session(s) assigned</span>}</span>
      </div>
      {legacyAssigned && !schedules.length && <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 8 }}>Currently assigned: {legacyAssigned} (no fixed schedule set yet)</div>}
      {schedules.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {schedules.map(s => (
            <ScheduleRow
              key={s.id} clientId={clientId} discipline={discipline} disciplineLabel={disciplineLabel}
              allTherapists={allTherapists} schedule={s} allActiveSchedules={allActiveSchedules}
              onChanged={onChanged} toast={toast}
            />
          ))}
        </div>
      )}
      {atRecommendedCap ? (
        <div style={{ fontSize: 11.5, color: '#94A3B8' }}>At the recommended weekly session count. Discharge one above, or raise the recommendation, to add another.</div>
      ) : roleTherapists.length === 0 ? (
        <div style={{ fontSize: 11.5, color: '#94A3B8' }}>No other registered {discipline === 'OT' ? 'Occupational' : 'Speech-Language'} therapists available.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pendingSlots.map((slot, i) => {
            // A therapist already picked in another one of these simultaneous
            // rows is excluded here too (1 session per therapist per week, same
            // rule as against already-committed schedules), but stays selectable
            // in ITS OWN row, same "own current pick is never taken from its own
            // point of view" pattern ScheduleRow already uses.
            const takenByOtherRows = new Set(pendingSlots.filter((_, j) => j !== i).map(s => s.therapistName).filter(Boolean));
            const availableTherapists = roleTherapists.filter(t => !takenByOtherRows.has(t.name));
            // Day/time conflict set for THIS row: real committed schedules
            // (useTakenTimes itself narrows these to just this discipline,
            // see selfConflict there) plus this discipline's OTHER pending
            // rows, merged in so the picker grays an about-to-collide slot
            // out immediately, not just after a failed Save Changes attempt.
            // A sibling discipline's picks are deliberately NOT included -
            // a Combined client can have OT and Speech at the same day/time.
            const conflictSchedules = [
              ...allActiveSchedules,
              ...pendingAsSchedules(pendingSlots.filter((_, j) => j !== i), discipline)
            ];
            return (
              <PendingSlotPicker
                key={i} slot={slot} onChange={next => updateSlot(i, next)}
                roleTherapists={availableTherapists} allActiveSchedules={conflictSchedules}
                discipline={discipline} clientId={clientId} disciplineLabel={disciplineLabel}
                toast={toast} busy={busy} setBusy={setBusy}
              />
            );
          })}
          <div style={{ fontSize: 11, color: '#94A3B8' }}>
            {busy ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 5 }} />Assigning…</> : `Picked above? It's assigned when you click Save Changes.`}
          </div>
        </div>
      )}
    </div>
  );
});

export default function EditClientModal({ data, closeModal, toast }) {
  const [first = '', last = ''] = (data.name || '').split(' ');
  const therapyLabels = { OT: 'Occupational Therapy', Speech: 'Speech Therapy', Both: 'Combined' };
  const therapyValues = { 'Occupational Therapy': 'OT', 'Speech Therapy': 'Speech', 'Combined': 'Both' };
  const [therapyLabel, setTherapyLabel] = useState(therapyLabels[data.therapy_type] || '');
  const therapyType = therapyValues[therapyLabel] || '';
  const showOt = therapyType === 'OT' || therapyType === 'Both';
  const showSpeech = therapyType === 'Speech' || therapyType === 'Both';

  // Real recurring schedules for this client, drives whether each discipline
  // shows a read-only summary or the assignment form (see DisciplineScheduleSection).
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoading, setSchedulesLoading] = useState(!!data.clientId);
  function loadSchedules() {
    if (!data.clientId) return;
    setSchedulesLoading(true);
    api('/reservations/' + data.clientId + '/schedules')
      .then(list => setSchedules(list || []))
      .catch(() => setSchedules([]))
      .finally(() => setSchedulesLoading(false));
  }
  useEffect(loadSchedules, [data.clientId]);
  const activeSchedules = schedules.filter(s => s.status === 'active');
  const otSchedules = activeSchedules.filter(s => s.discipline === 'OT');
  const speechSchedules = activeSchedules.filter(s => s.discipline === 'Speech');

  // How many sessions/week staff recommends per discipline, independent of how
  // many therapists end up fulfilling it (1 session per therapist per week
  // policy, so 2x/week needs 2 different therapists' schedules).
  const [recommendedOt, setRecommendedOt] = useState(data.recommendedOt ?? 1);
  const [recommendedSpeech, setRecommendedSpeech] = useState(data.recommendedSpeech ?? 1);


  // Normally driven by an actual completed "Initial Assessment" reservation
  // (see POST /reservations/:clientId/assign-schedule), but staff can override
  // it by hand here, e.g. intake that happened before this system was in use,
  // or to correct a mistake, without fabricating a fake reservation. Saved
  // immediately on flip (like the schedule actions below), not batched into
  // Save Changes, so it actually takes effect before "Assign ... Schedule" in
  // this same modal checks it, rather than only after the whole form is saved.
  const [iaCompleted, setIaCompleted] = useState(!!data.initial_assessment_completed);
  const [iaSaving, setIaSaving] = useState(false);

  // Refs to each discipline's pending (not-yet-assigned) picker, so a single
  // Save Changes commits everything: the profile fields below AND any
  // therapist/day/time picked but not yet submitted in either section, no
  // more separate "Assign ... Schedule" button per discipline.
  const otSectionRef = useRef(null);
  const speechSectionRef = useRef(null);
  const [saving, setSaving] = useState(false);
  async function toggleIaCompleted(checked) {
    if (!data.clientId) { setIaCompleted(checked); return; }
    setIaSaving(true);
    try {
      await api('/clients/' + data.clientId, { method: 'PUT', body: { initial_assessment_completed: checked } });
      setIaCompleted(checked);
      toast(`Initial Assessment marked ${checked ? 'completed' : 'not completed'}`, 'fa-check');
    } catch (e) {
      toast(e.message || 'Failed to update Initial Assessment status', 'fa-triangle-exclamation');
    } finally {
      setIaSaving(false);
    }
  }

  return (
    <Modal title={<><i className="fa-solid fa-user-pen" style={{ color: '#0EA5E9', marginRight: 8 }} />Edit Client Profile</>} onClose={closeModal} width={520}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label className="form-label">First Name</label><input id="ec-first" className="form-input" defaultValue={first} onInput={onNameInput('ec-first-note')} /><div id="ec-first-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Last Name</label><input id="ec-last" className="form-input" defaultValue={last} onInput={onNameInput('ec-last-note')} /><div id="ec-last-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Guardian</label><input id="ec-guardian" className="form-input" defaultValue={data.guardian || ''} onInput={onNameInput('ec-guardian-note')} /><div id="ec-guardian-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div style={{ gridColumn: '1/-1' }}>
          <label className="form-label">Therapy Type</label>
          <select id="ec-therapy" className="form-select" value={therapyLabel} onChange={e => {
            const next = e.target.value;
            // A discipline still covered by an active (not discharged) fixed
            // schedule can't be dropped out from under it here - the schedule
            // would keep auto-filling reservations for a discipline the
            // client's own profile no longer lists. Discharge it first (in
            // the section below) if the therapy type genuinely needs to change.
            const dropsOt = otSchedules.length > 0 && next !== 'Occupational Therapy' && next !== 'Combined';
            const dropsSpeech = speechSchedules.length > 0 && next !== 'Speech Therapy' && next !== 'Combined';
            if (dropsOt || dropsSpeech) {
              toast(`Discharge the active ${dropsOt ? 'Occupational' : 'Speech-Language'} Therapy schedule below before changing Therapy Type away from it.`, 'fa-triangle-exclamation');
              return;
            }
            setTherapyLabel(next);
          }}>
            <option value="" disabled={otSchedules.length > 0 || speechSchedules.length > 0}>Not yet assigned</option>
            <option disabled={speechSchedules.length > 0}>Occupational Therapy</option>
            <option disabled={otSchedules.length > 0}>Speech Therapy</option>
            <option>Combined</option>
          </select>
          {(otSchedules.length > 0 || speechSchedules.length > 0) && (
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>
              <i className="fa-solid fa-lock" style={{ marginRight: 5 }} />
              {otSchedules.length > 0 && speechSchedules.length > 0
                ? 'Has active OT and Speech Therapy schedules, discharge one below to narrow the therapy type.'
                : `Has an active ${otSchedules.length > 0 ? 'OT' : 'Speech Therapy'} schedule, discharge it below to remove that discipline.`}
            </div>
          )}
        </div>
        <div style={{ gridColumn: '1/-1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid #E2E8F0', borderRadius: 10, padding: '10px 14px', background: '#FAFBFC' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0F172A' }}>Initial Assessment Completed</div>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 40, height: 22, flexShrink: 0, marginLeft: 12, cursor: iaSaving ? 'wait' : 'pointer', opacity: iaSaving ? 0.6 : 1 }}>
            <input type="checkbox" checked={iaCompleted} disabled={iaSaving} onChange={e => toggleIaCompleted(e.target.checked)} style={{ position: 'absolute', opacity: 0, width: '100%', height: '100%', margin: 0, cursor: iaSaving ? 'wait' : 'pointer' }} />
            <span style={{ position: 'absolute', inset: 0, background: iaCompleted ? '#0EA5E9' : '#CBD5E1', borderRadius: 999, transition: 'background .15s', pointerEvents: 'none' }} />
            <span style={{ position: 'absolute', top: 3, left: iaCompleted ? 21 : 3, width: 16, height: 16, background: '#fff', borderRadius: '50%', transition: 'left .15s', pointerEvents: 'none' }} />
          </label>
        </div>

        {therapyType === '' ? (
          <div style={{ gridColumn: '1/-1' }}>
            <label className="form-label">Therapy Schedule</label>
            <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC' }}>Choose a therapy type first</div>
          </div>
        ) : !data.clientId ? (
          <div style={{ gridColumn: '1/-1', fontSize: 11.5, color: '#94A3B8' }}>Reopen this client's record to manage their therapy schedule.</div>
        ) : schedulesLoading ? (
          <div style={{ gridColumn: '1/-1', fontSize: 12.5, color: '#94A3B8' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading therapy schedule…</div>
        ) : (
          <>
            {showOt && (
              <>
                <div style={{ gridColumn: '1/-1' }}>
                  <label className="form-label">Occupational Therapy Sessions Recommended Per Week</label>
                  <select className="form-select" value={recommendedOt} onChange={e => setRecommendedOt(e.target.value)}>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} per week</option>)}
                  </select>
                </div>
                <DisciplineScheduleSection
                  ref={otSectionRef}
                  clientId={data.clientId} discipline="OT" disciplineLabel="Occupational Therapy"
                  allTherapists={data.therapists} legacyAssigned={data.assignedOt} schedules={otSchedules}
                  allActiveSchedules={activeSchedules}
                  recommended={recommendedOt === '' ? null : Number(recommendedOt)}
                  onChanged={loadSchedules} toast={toast}
                />
              </>
            )}
            {showSpeech && (
              <>
                <div style={{ gridColumn: '1/-1' }}>
                  <label className="form-label">Speech Therapy Sessions Recommended Per Week</label>
                  <select className="form-select" value={recommendedSpeech} onChange={e => setRecommendedSpeech(e.target.value)}>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} per week</option>)}
                  </select>
                </div>
                <DisciplineScheduleSection
                  ref={speechSectionRef}
                  clientId={data.clientId} discipline="Speech" disciplineLabel="Speech Therapy"
                  allTherapists={data.therapists} legacyAssigned={data.assignedSpeech} schedules={speechSchedules}
                  allActiveSchedules={activeSchedules}
                  recommended={recommendedSpeech === '' ? null : Number(recommendedSpeech)}
                  onChanged={loadSchedules} toast={toast}
                />
              </>
            )}
          </>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button className="btn-primary" disabled={saving} onClick={async () => {
        setSaving(true);
        try {
          // Commit any picked-but-not-yet-submitted therapist/day/time in
          // either discipline section first, if either fails (e.g. a slot
          // conflict or an incomplete pick), keep the modal open so staff can
          // fix it rather than silently dropping the profile-field changes too.
          const otOk = showOt && otSectionRef.current ? await otSectionRef.current.commitPending() : true;
          const speechOk = showSpeech && speechSectionRef.current ? await speechSectionRef.current.commitPending() : true;
          if (!otOk || !speechOk) return;

          const firstVal = document.getElementById('ec-first').value.trim();
          const lastVal = document.getElementById('ec-last').value.trim();
          const guardian = document.getElementById('ec-guardian').value.trim();
          const fullName = firstVal + (lastVal ? ' ' + lastVal : '');
          const cb = data.onSave;
          closeModal();
          if (cb) cb({
            name: fullName, initials: (firstVal[0] || '') + (lastVal[0] || ''), guardian, therapy_type: therapyType,
            recommendedOt: recommendedOt === '' ? null : Number(recommendedOt),
            recommendedSpeech: recommendedSpeech === '' ? null : Number(recommendedSpeech)
          });
          toast('Client profile updated: ' + fullName, 'fa-check');
        } finally {
          setSaving(false);
        }
      }}><i className={'fa-solid ' + (saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 5 }} />{saving ? 'Saving…' : 'Save Changes'}</button></div>
    </Modal>
  );
}

import { useState, useEffect } from 'react';
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
 * mistaken for one of the schedule's own weekly misses), treats a past
 * confirmed/rescheduled row nobody explicitly resolved as attended (same as
 * everywhere else in the app), and requires each absence to be exactly 7
 * days apart from the next - a week the family never booked at all leaves no
 * row, and silently skipping past that gap would let non-consecutive misses
 * masquerade as one real streak.
 */
function computeAttendanceStreak(schedule) {
  const today = todayPH();
  const resolved = (schedule.reservations || [])
    .filter(r => !r.is_makeup && (
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
 * three independent sources, split into two kinds:
 *
 * `blocked` (can't be picked at all): the therapist's own real booked shift
 * capacity (GET /reservations/slots) is full, or this same client's OWN other
 * active schedule already has them booked elsewhere that same day/time (they
 * can't be in two sessions at once, and there's no "waitlist" for a conflict
 * with yourself).
 *
 * `waitlistable` (still pickable): ANOTHER active recurring schedule already
 * pinned to that exact day/time/therapist (GET /recurring-schedules/taken, a
 * schedule is a standing pin, not a booked reservation, so the slots endpoint
 * alone can't see it). This one stays selectable on purpose, picking it and
 * clicking Assign is exactly how "Add to Waitlist Instead" gets offered,
 * graying it out identically to a hard block would make the waitlist
 * unreachable through the UI.
 *
 * `excludeScheduleId` lets an edit-in-place exclude the schedule being edited
 * from all three checks, otherwise it would flag itself as a conflict.
 */
function useTakenTimes(therapistName, dayOfWeek, allActiveSchedules, excludeScheduleId) {
  const [shiftTaken, setShiftTaken] = useState(new Set());
  useEffect(() => {
    if (!therapistName || dayOfWeek === '') { setShiftTaken(new Set()); return; }
    let cancelled = false;
    const date = nextOccurrenceDate(Number(dayOfWeek));
    api('/reservations/slots?date=' + date + '&therapist_name=' + encodeURIComponent(therapistName))
      .then(slots => { if (!cancelled) setShiftTaken(new Set((slots || []).filter(s => (s.available ?? 0) <= 0).map(s => s.time_slot))); })
      .catch(() => { if (!cancelled) setShiftTaken(new Set()); });
    return () => { cancelled = true; };
  }, [therapistName, dayOfWeek]);

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
    : new Set((allActiveSchedules || []).filter(s => s.day_of_week === Number(dayOfWeek) && s.id !== excludeScheduleId).map(s => s.time_slot));

  return { blocked: new Set([...shiftTaken, ...clientTaken]), waitlistable: scheduleTaken };
}

/** Shared Therapist/Day/Time picker markup for both the "assign new" form
 *  and a schedule's inline edit form, so their behavior (and the taken-time
 *  graying) never drifts apart. `takenTimes` is the { blocked, waitlistable }
 *  shape from useTakenTimes. */
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
          {WEEKDAY_NAMES.map((name, idx) => <option key={idx} value={idx}>{name}</option>)}
        </select>
      </div>
      <div>
        <label className="form-label">Time Slot</label>
        {!therapistName || dayOfWeek === '' ? (
          <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC', fontSize: 12 }}>Pick therapist &amp; day first</div>
        ) : !worksChosenDay ? (
          <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#DC2626', background: '#FEF2F2', fontSize: 12 }}>Not on shift {WEEKDAY_NAMES[dayOfWeek]}s</div>
        ) : (
          <select className="form-select" value={timeSlot} onChange={e => setTimeSlot(e.target.value)} style={timeSlot && takenTimes.blocked.has(timeSlot) ? { color: '#94A3B8' } : timeSlot && takenTimes.waitlistable.has(timeSlot) ? { color: '#B45309' } : undefined}>
            <option value="">- Select -</option>
            {timeOptions.map(t => {
              const blocked = takenTimes.blocked.has(t);
              const waitlistable = !blocked && takenTimes.waitlistable.has(t);
              return (
                // Every option sets its own color explicitly, an option with
                // no color of its own would otherwise inherit the <select>'s
                // (set below to reflect the currently chosen value), turning
                // the WHOLE open list that color instead of just this one row.
                <option key={t} value={t} disabled={blocked} style={{ color: blocked ? '#CBD5E1' : waitlistable ? '#B45309' : '#0F172A' }}>
                  {t}{blocked ? ' (occupied)' : waitlistable ? ' (taken, pick to join waitlist)' : ''}
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
  const takenTimes = useTakenTimes(editing ? therapistName : '', editing ? dayOfWeek : '', allActiveSchedules, schedule.id);

  function startEdit() {
    setTherapistName(schedule.therapist_name);
    setDayOfWeek(String(schedule.day_of_week));
    setTimeSlot(schedule.time_slot);
    setEditing(true);
  }

  async function save() {
    if (!therapistName || dayOfWeek === '' || !timeSlot) return toast('Fill in therapist, day, and time', 'fa-triangle-exclamation');
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
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-primary" style={{ fontSize: 11.5, padding: '6px 12px' }} disabled={busy} onClick={save}>
          <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-check')} style={{ marginRight: 5 }} />{busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-secondary" style={{ fontSize: 11.5, padding: '6px 12px' }} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
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
function DisciplineScheduleSection({ clientId, discipline, disciplineLabel, allTherapists, legacyAssigned, schedules, allActiveSchedules, recommended, onChanged, toast }) {
  // Therapists already covering this discipline for this client are excluded,
  // 1 session per therapist per week, the same person can't hold a second slot.
  const takenTherapistNames = new Set(schedules.map(s => s.therapist_name));
  const roleTherapists = (allTherapists || []).filter(t => t.role === (discipline === 'OT' ? 'ot' : 'speech') && !takenTherapistNames.has(t.name));
  const atRecommendedCap = recommended != null && schedules.length >= recommended;
  const [therapistName, setTherapistName] = useState('');
  const [dayOfWeek, setDayOfWeek] = useState('');
  const [timeSlot, setTimeSlot] = useState('');
  const [busy, setBusy] = useState(false);

  // Every time_slot already spoken for on this weekday for whichever
  // therapist is picked: their own real shift capacity, ANOTHER active
  // schedule already pinned to that exact combo, or this same client's own
  // other schedules, so it's grayed out here too instead of only failing
  // once "Assign" is clicked (see useTakenTimes above).
  const takenTimes = useTakenTimes(therapistName, dayOfWeek, allActiveSchedules, null);

  // Set when assign() hits a slot another client already holds, offers
  // "Add to Waitlist" instead of just a dead-end error.
  const [slotConflict, setSlotConflict] = useState(null);

  async function assign() {
    if (!therapistName) return toast('Select a therapist', 'fa-triangle-exclamation');
    if (dayOfWeek === '') return toast('Select a day of the week', 'fa-triangle-exclamation');
    if (!timeSlot) return toast('Select a time slot', 'fa-triangle-exclamation');
    setSlotConflict(null);
    setBusy(true);
    try {
      await api('/reservations/' + clientId + '/assign-schedule', {
        method: 'POST',
        body: { discipline, therapist_name: therapistName, day_of_week: Number(dayOfWeek), time_slot: timeSlot }
      });
      toast(`${disciplineLabel} schedule assigned: ${WEEKDAY_NAMES[dayOfWeek]}s at ${timeSlot} with ${therapistName}`, 'fa-check');
      onChanged();
    } catch (e) {
      toast(e.message || 'Failed to assign schedule', 'fa-triangle-exclamation');
      if (e.data?.slotTaken) setSlotConflict({ therapistName, dayOfWeek: Number(dayOfWeek), timeSlot });
    } finally {
      setBusy(false);
    }
  }

  async function addToWaitlist() {
    if (!slotConflict) return;
    setBusy(true);
    try {
      await api('/reservations/schedule-waitlist', {
        method: 'POST',
        body: { discipline, therapist_name: slotConflict.therapistName, day_of_week: slotConflict.dayOfWeek, time_slot: slotConflict.timeSlot, client_id: clientId }
      });
      toast('Added to the waitlist for that slot', 'fa-check');
      setSlotConflict(null);
    } catch (e) {
      toast(e.message || 'Failed to add to waitlist', 'fa-triangle-exclamation');
    } finally {
      setBusy(false);
    }
  }

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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <ScheduleTimePicker
            therapistName={therapistName} setTherapistName={setTherapistName}
            dayOfWeek={dayOfWeek} setDayOfWeek={setDayOfWeek}
            timeSlot={timeSlot} setTimeSlot={setTimeSlot}
            roleTherapists={roleTherapists} takenTimes={takenTimes}
          />
          <div style={{ gridColumn: '1/-1', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-primary" style={{ fontSize: 12, padding: '7px 14px' }} disabled={busy} onClick={assign}>
              <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-calendar-plus')} style={{ marginRight: 5 }} />{busy ? 'Assigning…' : `Assign ${disciplineLabel} Schedule`}
            </button>
            {slotConflict && (
              <button className="btn-secondary" style={{ fontSize: 12, padding: '7px 14px' }} disabled={busy} onClick={addToWaitlist}>
                <i className="fa-solid fa-user-clock" style={{ marginRight: 5 }} />Add to Waitlist Instead
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Therapy Type</label><select id="ec-therapy" className="form-select" value={therapyLabel} onChange={e => setTherapyLabel(e.target.value)}><option value="">Not yet assigned</option><option>Occupational Therapy</option><option>Speech Therapy</option><option>Combined</option></select></div>
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
                    <option value="">Not set (no cap)</option>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} per week</option>)}
                  </select>
                </div>
                <DisciplineScheduleSection
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
                    <option value="">Not set (no cap)</option>
                    {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} per week</option>)}
                  </select>
                </div>
                <DisciplineScheduleSection
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button className="btn-primary" onClick={() => {
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
      }}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Save Changes</button></div>
    </Modal>
  );
}

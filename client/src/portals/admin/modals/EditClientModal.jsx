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

  // Real availability for the therapist's actual next occurrence of this
  // weekday, same slots endpoint/logic the real booking calendar uses, so an
  // hour they're already committed to (another recurring schedule, or any
  // one-off booking) shows taken here too, instead of only failing at submit.
  const [shiftTakenTimes, setShiftTakenTimes] = useState(new Set());
  useEffect(() => {
    if (!therapistName || dayOfWeek === '') { setShiftTakenTimes(new Set()); return; }
    let cancelled = false;
    const date = nextOccurrenceDate(Number(dayOfWeek));
    api('/reservations/slots?date=' + date + '&therapist_name=' + encodeURIComponent(therapistName))
      .then(slots => {
        if (cancelled) return;
        const taken = new Set((slots || []).filter(s => (s.available ?? 0) <= 0).map(s => s.time_slot));
        setShiftTakenTimes(taken);
      })
      .catch(() => { if (!cancelled) setShiftTakenTimes(new Set()); });
    return () => { cancelled = true; };
  }, [therapistName, dayOfWeek]);

  // The child can only be in one session at a time, so any time slot they're
  // already committed to on this weekday (any OTHER active schedule, same
  // discipline or not, e.g. a Combined client's Speech schedule) is grayed
  // out here too, instead of only failing once "Assign" is clicked.
  const clientTakenTimes = dayOfWeek === ''
    ? new Set()
    : new Set((allActiveSchedules || []).filter(s => s.day_of_week === Number(dayOfWeek)).map(s => s.time_slot));
  const takenTimes = new Set([...shiftTakenTimes, ...clientTakenTimes]);

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

  async function discharge(scheduleId) {
    setBusy(true);
    try {
      const result = await api('/reservations/recurring-schedules/' + scheduleId, { method: 'PUT', body: { status: 'discharged' } });
      toast(
        result.notifiedWaitlistClient
          ? `${disciplineLabel} schedule discharged, ${result.notifiedWaitlistClient} (next on the waitlist) was notified`
          : `${disciplineLabel} schedule discharged`,
        'fa-check'
      );
      onChanged();
    } catch (e) {
      toast(e.message || 'Failed to discharge schedule', 'fa-triangle-exclamation');
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
            <div key={s.id} style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 10, background: '#fff' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: '#0F172A' }}>
                {WEEKDAY_NAMES[s.day_of_week]}s {s.time_slot} with {s.therapist_name}{s.sessions_completed ? ` · ${s.sessions_completed} completed` : ''}
              </div>
              <button className="btn-secondary" disabled={busy} onClick={() => discharge(s.id)} style={{ fontSize: 11, padding: '5px 9px', flexShrink: 0 }}>Discharge</button>
            </div>
          ))}
        </div>
      )}
      {atRecommendedCap ? (
        <div style={{ fontSize: 11.5, color: '#94A3B8' }}>At the recommended weekly session count. Discharge one above, or raise the recommendation, to add another.</div>
      ) : roleTherapists.length === 0 ? (
        <div style={{ fontSize: 11.5, color: '#94A3B8' }}>No other registered {discipline === 'OT' ? 'Occupational' : 'Speech-Language'} therapists available.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
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
              <select className="form-select" value={timeSlot} onChange={e => setTimeSlot(e.target.value)} style={timeSlot && takenTimes.has(timeSlot) ? { color: '#94A3B8' } : undefined}>
                <option value="">- Select -</option>
                {timeOptions.map(t => (
                  <option key={t} value={t} disabled={takenTimes.has(t)} style={takenTimes.has(t) ? { color: '#CBD5E1' } : undefined}>
                    {t}{takenTimes.has(t) ? ' (occupied)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
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
  const [recommendedOt, setRecommendedOt] = useState(data.recommendedOt ?? '');
  const [recommendedSpeech, setRecommendedSpeech] = useState(data.recommendedSpeech ?? '');

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
            <div style={{ fontSize: 11, color: '#94A3B8' }}>Manual override, for intake done before this system was in use, or to correct a mistake. Normally set automatically once a booked Initial Assessment is marked completed.</div>
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={() => {
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

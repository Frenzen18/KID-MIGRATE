import { useEffect, useState } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { api } from '../../../../api.js';
import { rateForSessionType, effectiveSlotAvailable, REQUIRED_ROLE_FOR_TYPE, therapistWorksOn } from './reservationsHelpers.js';

// A Combined client carries two independent assigned therapists (one OT, one
// Speech), never a single shared field, this picks the one matching the
// session type being booked, mirrors server/routes/reservations.js's own helper.
function assignedTherapistForType(client, sessionType) {
  if (!client) return null;
  if (sessionType === 'Occupational Therapy' || sessionType === 'Occupational Assessment') return client.assigned_ot_therapist_name || null;
  if (sessionType === 'Speech Therapy' || sessionType === 'Speech-Language Assessment') return client.assigned_speech_therapist_name || null;
  return null;
}

/** Earliest bookable date (tomorrow, PH time), mirrors the server's own "at least a day ahead" rule. */
function minBookableDateStr() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

export default function BookingModal({ selected, daySlots, slotState, defaultTime, time, clients, clientLabel, serviceType, busy, onClose, onConfirm, onBooked, toast }) {
  const requiredRole = REQUIRED_ROLE_FOR_TYPE[serviceType] || null;
  // Make-up session: books an open gap with the client's own assigned
  // therapist without needing it to match their fixed day/time, see the
  // checkbox below. Read by confirmBooking() in the parent (Reservations.jsx)
  // via #modal-is-makeup, same DOM-read pattern the rest of this form uses.
  const [isMakeup, setIsMakeup] = useState(false);

  // Initial Assessment is for intake, only clients with neither a therapy type
  // nor an assigned therapist yet are eligible, anyone with either already set
  // has already been through intake.
  const isInitialAssessment = serviceType === 'Initial Assessment';
  // Speech-Language/Occupational Assessment are follow-ups for clients already
  // designated into that discipline (or Combined), not a fresh intake, so only
  // clients matching that therapy_type are selectable.
  const DISCIPLINE_FOR_TYPE = { 'Speech-Language Assessment': 'Speech', 'Occupational Assessment': 'OT', 'Occupational Therapy': 'OT', 'Speech Therapy': 'Speech' };
  const requiredDiscipline = DISCIPLINE_FOR_TYPE[serviceType];
  const bookableClients = isInitialAssessment
    ? clients.filter(c => !c.assigned_ot_therapist_name && !c.assigned_speech_therapist_name && !c.therapy_type)
    : requiredDiscipline
      ? clients.filter(c => c.therapy_type === requiredDiscipline || c.therapy_type === 'Both')
      : clients;

  const [selectedClientId, setSelectedClientId] = useState('');

  // Searchable client picker: types to filter, shows at most 4 matches at a
  // time instead of one long native <select> of every eligible client.
  const [clientSearch, setClientSearch] = useState('');
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const clientMatches = bookableClients
    .filter(c => clientLabel(c).toLowerCase().includes(clientSearch.trim().toLowerCase()))
    .slice(0, 4);
  function pickClient(c) {
    setSelectedClientId(c.id);
    setClientSearch(clientLabel(c));
    setClientDropdownOpen(false);
  }

  // Discipline-specific assessments (Speech-Language/Occupational) require
  // picking a therapist of that discipline, right below Client, before a
  // time slot can be chosen.
  const [therapists, setTherapists] = useState([]);
  const [selectedTherapist, setSelectedTherapist] = useState('');
  useEffect(() => {
    if (!requiredRole) return;
    let cancelled = false;
    api('/shifts').then(data => { if (!cancelled) setTherapists(data || []); }).catch(() => { if (!cancelled) setTherapists([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredRole]);
  // A discipline-specific assessment is a follow-up for a client already in
  // that program, so the only valid therapist is the one they're actually
  // assigned to, not just anyone of that discipline on shift, picking a
  // different therapist would silently reassign the client's care.
  const selectedClient = bookableClients.find(cl => cl.id === selectedClientId);
  const selectedClientAssignedTherapist = assignedTherapistForType(selectedClient, serviceType);
  const eligibleTherapists = selectedClientAssignedTherapist
    ? therapists.filter(t => t.name === selectedClientAssignedTherapist
        && t.role === requiredRole && therapistWorksOn(t, selected.date))
    : [];

  // Auto-select the client's own assigned therapist, it's the only option,
  // there's nothing for staff to actually choose between.
  useEffect(() => {
    if (!requiredRole) return;
    setSelectedTherapist(eligibleTherapists.length === 1 ? eligibleTherapists[0].name : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, therapists]);

  // For a regular Occupational/Speech Therapy booking, surface the client's
  // fixed recurring schedule(s) for this discipline, if any, so staff can see
  // at a glance which day/time/therapist to pick instead of guessing.
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const [clientSchedules, setClientSchedules] = useState([]);
  useEffect(() => {
    if (!selectedClientId || !DISCIPLINE_FOR_TYPE[serviceType]) { setClientSchedules([]); return; }
    let cancelled = false;
    api('/reservations/' + selectedClientId + '/schedules')
      .then(list => { if (!cancelled) setClientSchedules((list || []).filter(s => s.status === 'active' && s.discipline === DISCIPLINE_FOR_TYPE[serviceType])); })
      .catch(() => { if (!cancelled) setClientSchedules([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, serviceType]);

  // Which of this client's fixed schedule times are valid for the day being
  // booked (selected.date is fixed for the whole modal, staff picked it by
  // clicking that calendar day), used to grey out any Start Time that isn't
  // one of them for a regular (non-make-up) booking, mirrors the same lock
  // server-side, see POST /reservations.
  const schedulesForWeekday = clientSchedules.filter(s => s.day_of_week === new Date(selected.date + 'T00:00:00Z').getUTCDay());
  const scheduleTimesForWeekday = schedulesForWeekday.map(s => s.time_slot);
  // Which therapist a fixed-schedule time is with, e.g. 7 AM is always Frenz
  // Dil for this client, not a "pick from N free" situation like an
  // unscheduled booking, showing the name is more useful than a free-count.
  const scheduleTherapistByTime = Object.fromEntries(schedulesForWeekday.map(s => [s.time_slot, s.therapist_name]));

  // A client can have more than one active schedule for this discipline
  // (2x/week needs 2 different therapists), so there isn't always a single
  // "the" assigned therapist, unlike assignedTherapistForType's single field.
  // Prefer the real schedule list; only fall back to that field when no
  // schedule row exists yet (e.g. legacy data).
  const selectedClientForSchedule = bookableClients.find(cl => cl.id === selectedClientId);
  const scheduleTherapistNames = [...new Set(clientSchedules.map(s => s.therapist_name))];
  const fallbackAssignedName = !requiredRole ? assignedTherapistForType(selectedClientForSchedule, serviceType) : null;
  const availableTherapistNames = scheduleTherapistNames.length ? scheduleTherapistNames : (fallbackAssignedName ? [fallbackAssignedName] : []);

  // A make-up session only exists to catch up an actual missed occurrence, so
  // it's only offered at all when the client has one on file, never as a
  // free-floating "extra session" with no cancellation behind it (mirrors the
  // same requirement server-side, see outstandingMakeupTherapists in
  // server/routes/reservations.js). Checked as soon as a client is picked,
  // not gated behind the checkbox itself, since it decides whether the
  // checkbox even appears. A cancellation only counts as still outstanding if
  // that exact date's slot with that therapist was never re-filled afterward
  // (e.g. cancelled then immediately rebooked at the same date/time to fix a
  // mistake isn't a real gap). Accumulates across ALL time rather than
  // resetting weekly: every real miss (ever) is a banked entitlement per
  // therapist until it's actually used by a make-up, it never expires on its
  // own.
  const [outstandingMakeupTherapists, setOutstandingMakeupTherapists] = useState([]);
  useEffect(() => {
    if (!selectedClientId || requiredRole) { setOutstandingMakeupTherapists([]); return; }
    let cancelledReq = false;
    api('/reservations?client_id=' + selectedClientId)
      .then(list => {
        if (cancelledReq) return;
        const all = (list || []).filter(r => r.session_type === serviceType);
        const misses = all.filter(r => !r.is_makeup && ['cancelled', 'no_show'].includes(r.status) && r.therapist_name
          && !all.some(other => other.id !== r.id && other.therapist_name === r.therapist_name
            && other.date === r.date && !['cancelled', 'declined'].includes(other.status)));
        const missCounts = {};
        misses.forEach(m => { missCounts[m.therapist_name] = (missCounts[m.therapist_name] || 0) + 1; });
        // Every make-up EVER booked (whatever later happens to it) spends one
        // entitlement, otherwise cancelling a make-up would look like a
        // fresh miss and mint another one, looping forever.
        const usedCounts = {};
        all.forEach(r => {
          if (r.is_makeup && r.status !== 'declined' && r.therapist_name) {
            usedCounts[r.therapist_name] = (usedCounts[r.therapist_name] || 0) + 1;
          }
        });
        const names = Object.keys(missCounts).filter(name => missCounts[name] > (usedCounts[name] || 0));
        setOutstandingMakeupTherapists(names);
      })
      .catch(() => { if (!cancelledReq) setOutstandingMakeupTherapists([]); });
    return () => { cancelledReq = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, serviceType, requiredRole]);
  const makeupCandidateNames = availableTherapistNames.filter(n => outstandingMakeupTherapists.includes(n));

  // A no-show or retainer fee blocks any NEW booking for this client, same
  // hard rule enforced server-side in POST /reservations (a regular session
  // invoice sitting Unpaid never blocks anything). Checked the moment a
  // client is picked, so staff see this immediately instead of only finding
  // out after filling out the whole form and clicking Confirm.
  const [outstandingBalance, setOutstandingBalance] = useState(null);
  useEffect(() => {
    if (!selectedClientId) { setOutstandingBalance(null); return; }
    let cancelledReq = false;
    api('/payments?client_id=' + selectedClientId)
      .then(list => {
        if (cancelledReq) return;
        const fee = (list || []).find(p => ['no_show_fee', 'retainer_fee'].includes(p.fee_type) && ['pending', 'overdue'].includes(p.status));
        setOutstandingBalance(fee || null);
      })
      .catch(() => { if (!cancelledReq) setOutstandingBalance(null); });
    return () => { cancelledReq = true; };
  }, [selectedClientId]);

  // Which of those therapists a make-up session is with, only actually asked
  // when there's more than one candidate, auto-picked when there's just one.
  const [makeupTherapist, setMakeupTherapist] = useState('');
  useEffect(() => {
    setMakeupTherapist(makeupCandidateNames.length === 1 ? makeupCandidateNames[0] : '');
    // No missed session left to make up (e.g. the client changed, or their
    // last outstanding cancellation got resolved), the checkbox is about to
    // disappear, don't leave isMakeup stuck true with nothing behind it.
    if (!makeupCandidateNames.length) setIsMakeup(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, clientSchedules, outstandingMakeupTherapists]);

  /**
   * Quick Book: staff/admin equivalent of the guardian portal's Quick Book,
   * instantly books several upcoming occurrences of a client's fixed
   * recurring schedule at once (paid per-session, stacking ahead is the whole
   * point of a permanent slot), instead of one date at a time through the
   * regular flow below. Only shown once a client with an active schedule for
   * this discipline is selected (see clientSchedules above), and only
   * expanded on demand (a checkbox, not shown by default) so it doesn't
   * lengthen the modal for the common case of booking just one date.
   */
  const [showQuickBook, setShowQuickBook] = useState(false);
  const [quickBookScheduleId, setQuickBookScheduleId] = useState('');
  const [quickBookCount, setQuickBookCount] = useState(4);
  const [quickBookSelected, setQuickBookSelected] = useState(new Set());
  const [quickBooking, setQuickBooking] = useState(false);
  const [existingClientSlots, setExistingClientSlots] = useState(new Set());
  useEffect(() => {
    if (!selectedClientId || !clientSchedules.length) { setExistingClientSlots(new Set()); return; }
    let cancelled = false;
    api('/reservations?client_id=' + selectedClientId)
      .then(list => {
        if (cancelled) return;
        setExistingClientSlots(new Set(
          (list || []).filter(r => ['awaiting_payment', 'pending', 'confirmed', 'rescheduled'].includes(r.status))
            .map(r => r.date + '|' + r.time_slot)
        ));
      })
      .catch(() => { if (!cancelled) setExistingClientSlots(new Set()); });
    return () => { cancelled = true; };
  }, [selectedClientId, clientSchedules.length]);

  function quickBookCandidates(schedule, limit) {
    if (!schedule) return [];
    const dates = [];
    const cursor = new Date(minBookableDateStr() + 'T00:00:00Z');
    for (let guard = 0; dates.length < limit && guard < 730; guard++) {
      const ds = cursor.toISOString().slice(0, 10);
      if (cursor.getUTCDay() === schedule.day_of_week && !existingClientSlots.has(ds + '|' + schedule.time_slot)) dates.push(ds);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }

  async function submitQuickBook(schedule, dates) {
    if (!schedule || !dates.length || quickBooking) return;
    setQuickBooking(true);
    let booked = 0, failed = 0;
    try {
      for (const date of dates) {
        try {
          await api('/reservations', {
            method: 'POST',
            body: { client_id: selectedClientId, date, time_slot: schedule.time_slot, session_type: serviceType, therapist_name: schedule.therapist_name }
          });
          booked++;
        } catch {
          failed++;
        }
      }
      if (booked > 0) {
        toast?.(`Booked ${booked} session${booked > 1 ? 's' : ''}${failed ? `, ${failed} couldn't be booked` : ''}`, 'fa-calendar-check');
        onBooked?.();
        onClose();
      } else {
        toast?.('Could not book the selected sessions', 'fa-triangle-exclamation');
      }
    } finally {
      setQuickBooking(false);
    }
  }

  // Once a client (or, for assessments, a therapist) is picked, re-fetch slots
  // scoped to that specific therapist's shift so Start Time only shows hours
  // they're actually available, instead of the whole clinic's combined capacity.
  const [scopedSlots, setScopedSlots] = useState(daySlots);
  useEffect(() => {
    const therapistParam = requiredRole ? selectedTherapist : '';
    const clientParam = !requiredRole ? selectedClientId : '';
    if (!therapistParam && !clientParam) { setScopedSlots(daySlots); return; }
    let cancelled = false;
    const qs = (therapistParam ? '&therapist_name=' + encodeURIComponent(therapistParam) : '&client_id=' + clientParam)
      + '&session_type=' + encodeURIComponent(serviceType);
    api('/reservations/slots?date=' + selected.date + qs)
      .then(data => { if (!cancelled) setScopedSlots(data); })
      .catch(() => { if (!cancelled) setScopedSlots(daySlots); });
    return () => { cancelled = true; };
  }, [selectedClientId, selectedTherapist, requiredRole, selected.date, daySlots]);

  useEffect(() => {
    const amt = document.getElementById('modal-amount');
    if (amt && serviceType) amt.value = rateForSessionType(serviceType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A make-up is exempt from the outstanding-balance lock (see the identical
  // exception server-side in POST /reservations), it's catching up an
  // existing miss, not a new regular booking, and the entitlement expires at
  // week's end regardless of when the fee gets settled.
  const timeFieldsLocked = (requiredRole && !selectedTherapist) || (!!outstandingBalance && !isMakeup);

  // #modal-time-select is uncontrolled (read via DOM at confirm time, like the
  // rest of this form), but the make-up therapist picker needs to know which
  // time is currently chosen so it can hide/disable whichever assigned
  // therapist is ALREADY booked at that exact hour, "1 of 2 free" otherwise
  // left the dropdown listing both regardless of which one that 1 actually is.
  const [selectedBookedTime, setSelectedBookedTime] = useState(defaultTime || '');
  const selectedTimeSlotInfo = scopedSlots.find(s => s.time_slot === selectedBookedTime) || null;
  const makeupTherapistFreeAtTime = name => !selectedTimeSlotInfo
    || ((selectedTimeSlotInfo.therapists || []).includes(name) && !(selectedTimeSlotInfo.reservations || []).some(r => r.therapist_name === name));
  useEffect(() => {
    if (makeupTherapist && !makeupTherapistFreeAtTime(makeupTherapist)) setMakeupTherapist('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBookedTime]);

  return (
    <Modal title={'Book Slot: ' + selected.label + ', ' + selected.year} onClose={onClose} width={540}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9, background: '#F0F9FF', border: '1px solid #BAE6FD', marginBottom: 16 }}>
        <i className="fa-solid fa-clipboard-check" style={{ color: 'var(--color-primary)', fontSize: 16 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{serviceType}</div>
          <div style={{ fontSize: 11.5, color: '#64748B' }}>{selected.label}, {selected.year}{time ? ' · Time slot: ' + time : ''}</div>
        </div>
      </div>
      <div id="bk-err" style={{ display: 'none', background: 'var(--color-danger-bg-soft)', border: '1px solid #FECACA', color: 'var(--color-danger)', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 14 }}>
        <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} /><span id="bk-err-msg" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1/-1', position: 'relative' }}>
          <label className="form-label">Client *</label>
          <input
            className="form-input"
            id="modal-client-select"
            autoComplete="off"
            placeholder="Type a name or client code…"
            value={clientSearch}
            onChange={e => {
              setClientSearch(e.target.value);
              setSelectedClientId('');
              setClientDropdownOpen(true);
            }}
            onFocus={() => setClientDropdownOpen(true)}
            onBlur={() => setClientDropdownOpen(false)}
          />
          {clientDropdownOpen && (
            <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, boxShadow: '0 8px 20px rgba(15,23,42,.1)', overflow: 'hidden' }}>
              {clientMatches.length ? clientMatches.map(c => (
                <div
                  key={c.id}
                  // onMouseDown (not onClick) fires before the input's onBlur closes the dropdown.
                  onMouseDown={e => { e.preventDefault(); pickClient(c); }}
                  style={{ padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', borderBottom: '1px solid #F1F5F9' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#F0F9FF'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                >
                  {clientLabel(c)}
                </div>
              )) : (
                <div style={{ padding: '8px 12px', fontSize: 12.5, color: '#94A3B8' }}>No matching clients</div>
              )}
            </div>
          )}
          {isInitialAssessment && !bookableClients.length && (
            <div style={{ fontSize: 11.5, color: 'var(--color-danger)', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />Every client already has a therapy type and therapist assigned, none are eligible for an Initial Assessment.</div>
          )}
          {requiredDiscipline && !bookableClients.length && (
            <div style={{ fontSize: 11.5, color: 'var(--color-danger)', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />No clients are designated for {requiredDiscipline === 'Speech' ? 'Speech-Language' : 'Occupational'} Therapy yet.</div>
          )}
          {!requiredRole && availableTherapistNames.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--color-primary)', marginTop: 5 }}>
              <i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />
              Showing available times for {availableTherapistNames.length === 1 ? `${availableTherapistNames[0]}'s schedule` : `${availableTherapistNames.join(' and ')}'s schedules`} only.
            </div>
          )}
          {clientSchedules.length > 0 && (
            <div style={{ fontSize: 11.5, color: '#0D9488', marginTop: 5 }}>
              <i className="fa-solid fa-calendar-week" style={{ marginRight: 5 }} />
              Fixed schedule: {clientSchedules.map((s, i) => <span key={s.id}>{i > 0 ? '; ' : ''}{WEEKDAY_NAMES[s.day_of_week]}s at {s.time_slot} with {s.therapist_name}</span>)}
            </div>
          )}
          {outstandingBalance && (
            <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA', display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className={'fa-solid ' + (isMakeup ? 'fa-circle-info' : 'fa-lock')} style={{ color: '#DC2626' }} />
              <span style={{ fontSize: 12, color: '#991B1B', fontWeight: 600 }}>
                {selectedClient?.full_name || 'This client'} has an unpaid {outstandingBalance.fee_type === 'retainer_fee' ? 'retainer fee' : 'no-show fee'} of ₱{Number(outstandingBalance.amount).toLocaleString()}.{' '}
                {isMakeup
                  ? 'A make-up session is still allowed while this is unpaid, since it\'s catching up an existing miss, not a new regular booking.'
                  : 'Settle or waive it from Payments before booking a new (non-make-up) session.'}
              </span>
            </div>
          )}
          {!requiredRole && makeupCandidateNames.length > 0 && (
            <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: isMakeup ? '#FFFBEB' : '#F8FAFC', border: '1px solid ' + (isMakeup ? '#FDE68A' : '#E2E8F0') }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input id="modal-is-makeup" type="checkbox" checked={isMakeup} onChange={e => setIsMakeup(e.target.checked)} style={{ marginTop: 2 }} />
                <span style={{ fontSize: 11.5, color: '#92400E' }}>
                  <strong>Book Make-up session</strong>
                </span>
              </label>
              {isMakeup && makeupCandidateNames.length > 1 && (
                <div style={{ marginTop: 8, marginLeft: 24 }}>
                  <label style={{ fontSize: 11.5, fontWeight: 600, color: '#92400E', display: 'block', marginBottom: 4 }}>Which assigned therapist is this make-up with? *</label>
                  <select id="modal-makeup-therapist" className="form-select" style={{ fontSize: 12.5 }} value={makeupTherapist} onChange={e => setMakeupTherapist(e.target.value)}>
                    <option value="">Select a therapist…</option>
                    {makeupCandidateNames.map(n => {
                      const free = makeupTherapistFreeAtTime(n);
                      return <option key={n} value={n} disabled={!free}>{n}{selectedTimeSlotInfo && !free ? ' (already booked at this time)' : ''}</option>;
                    })}
                  </select>
                  {selectedTimeSlotInfo && makeupCandidateNames.every(n => !makeupTherapistFreeAtTime(n)) && (
                    <div style={{ fontSize: 11, color: 'var(--color-danger)', marginTop: 4 }}>None of the assigned therapists are free at this time, pick a different Start Time.</div>
                  )}
                </div>
              )}
              <input type="hidden" id="modal-makeup-therapist-value" value={isMakeup ? makeupTherapist : ''} readOnly />
            </div>
          )}
          {clientSchedules.length > 0 && !isMakeup && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: '#0C4A6E', fontWeight: 600, marginTop: 10 }}>
              <input type="checkbox" checked={showQuickBook} onChange={e => setShowQuickBook(e.target.checked)} />
              <i className="fa-solid fa-calendar-week" style={{ color: '#0EA5E9' }} />
              Quick Book several weeks of this schedule at once
            </label>
          )}
          {clientSchedules.length > 0 && !isMakeup && showQuickBook && (() => {
            const qbSchedule = clientSchedules.find(s => s.id === quickBookScheduleId) || clientSchedules[0];
            const qbCandidates = quickBookCandidates(qbSchedule, Math.max(quickBookCount * 2, 10));
            const toggleDate = ds => setQuickBookSelected(prev => {
              const next = new Set(prev);
              next.has(ds) ? next.delete(ds) : next.add(ds);
              return next;
            });
            return (
              <div style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: 9, padding: '10px 12px', marginTop: 6, opacity: outstandingBalance ? .55 : 1, pointerEvents: outstandingBalance ? 'none' : 'auto' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  {clientSchedules.length > 1 && (
                    <select className="form-select" style={{ background: '#fff', width: 'auto', fontSize: 12, padding: '5px 8px' }} value={qbSchedule.id} onChange={e => { setQuickBookScheduleId(e.target.value); setQuickBookSelected(new Set()); }}>
                      {clientSchedules.map(s => <option key={s.id} value={s.id}>{WEEKDAY_NAMES[s.day_of_week]}s {s.time_slot} ({s.therapist_name})</option>)}
                    </select>
                  )}
                  <span style={{ fontSize: 12, color: '#0C4A6E' }}>How many?</span>
                  <input
                    type="number" min={1} max={26} className="form-input" style={{ width: 60, fontSize: 12, padding: '5px 8px' }}
                    value={quickBookCount}
                    onChange={e => {
                      const n = Math.max(1, Math.min(26, Number(e.target.value) || 1));
                      setQuickBookCount(n);
                      setQuickBookSelected(new Set(quickBookCandidates(qbSchedule, Math.max(n * 2, 10)).slice(0, n)));
                    }}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 6, maxHeight: 120, overflowY: 'auto', marginBottom: 8 }}>
                  {qbCandidates.length === 0 && <span style={{ fontSize: 11.5, color: '#0C4A6E' }}>No open upcoming dates found for this slot.</span>}
                  {qbCandidates.map(ds => {
                    const checked = quickBookSelected.has(ds);
                    return (
                      <label key={ds} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#0C4A6E', background: checked ? '#DBEAFE' : '#fff', border: '1px solid ' + (checked ? '#93C5FD' : '#E2E8F0'), borderRadius: 7, padding: '5px 8px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleDate(ds)} style={{ margin: 0 }} />
                        {ds}
                      </label>
                    );
                  })}
                </div>
                <button
                  type="button" className="btn-primary" style={{ fontSize: 11.5, padding: '6px 12px' }}
                  disabled={quickBooking || quickBookSelected.size === 0 || !!outstandingBalance}
                  onClick={() => submitQuickBook(qbSchedule, Array.from(quickBookSelected))}
                >
                  <i className={'fa-solid ' + (quickBooking ? 'fa-spinner fa-spin' : 'fa-bolt')} style={{ marginRight: 5 }} />
                  {quickBooking ? 'Booking…' : `Book Selected (${quickBookSelected.size})`}
                </button>
                <div style={{ fontSize: 10.5, color: '#0C4A6E', marginTop: 6 }}>Books directly into this fixed slot, confirmed right away, payment stays Unpaid until collected or paid via QRPh, same as booking one at a time below.</div>
              </div>
            );
          })()}
        </div>
        {requiredRole && (
          <div style={{ gridColumn: '1/-1' }}>
            <label className="form-label">{requiredRole === 'speech' ? 'Speech-Language Therapist *' : 'Occupational Therapist *'}</label>
            <select className="form-select" id="modal-therapist-select" value={selectedTherapist} onChange={e => setSelectedTherapist(e.target.value)} disabled={eligibleTherapists.length <= 1}>
              <option value="">- Select therapist -</option>
              {eligibleTherapists.map(t => <option key={t.therapist_id} value={t.name}>{t.name}</option>)}
            </select>
            {!selectedClientId && (
              <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 5 }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Select a client first.</div>
            )}
            {selectedClientId && !selectedClientAssignedTherapist && (
              <div style={{ fontSize: 11.5, color: 'var(--color-danger)', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />{selectedClient?.full_name || 'This client'} doesn't have an assigned therapist yet.</div>
            )}
            {selectedClientId && selectedClientAssignedTherapist && !eligibleTherapists.length && (
              <div style={{ fontSize: 11.5, color: 'var(--color-danger)', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />{selectedClientAssignedTherapist} is not on shift on {selected.label}.</div>
            )}
          </div>
        )}
        <fieldset disabled={timeFieldsLocked} style={{ display: 'contents', border: 0, margin: 0, padding: 0 }}>
        <div>
          <label className="form-label">Session Date</label>
          <input className="form-input" type="date" value={selected.date} readOnly style={{ background: '#F1F5F9', fontWeight: 600 }} />
        </div>
        <div>
          <label className="form-label">Start Time *</label>
          {/* A client with an active fixed schedule can only be regularly
              booked into that exact day/time (mirrors the same lock
              server-side, see POST /reservations), a make-up session is the
              one deliberate exception. When the picked DAY doesn't match the
              schedule at all, every hour would repeat the same "not this
              client's scheduled time" message, cluttered and not actually
              useful, one line explaining the day is wrong reads far cleaner. */}
          {!requiredRole && !isMakeup && clientSchedules.length > 0 && !scheduleTimesForWeekday.length ? (
            <div style={{ padding: '9px 12px', borderRadius: 8, background: '#F1F5F9', color: '#64748B', fontSize: 12.5 }}>
              <i className="fa-solid fa-lock" style={{ marginRight: 6 }} />
              {selected.label} isn't one of {selectedClientForSchedule?.full_name || 'this client'}'s fixed schedule days, pick a different day{makeupCandidateNames.length > 0 ? ', or check "make-up session" above' : ''}.
            </div>
          ) : (
            <select className="form-select" id="modal-time-select" defaultValue={defaultTime || ''} onChange={e => setSelectedBookedTime(e.target.value)}>
              <option value="" disabled>- Select time -</option>
              {scopedSlots
                // Hide (not just grey out) any hour that isn't part of the
                // client's fixed schedule for this day, no point cluttering
                // the list with times that were never bookable to begin with.
                .filter(s => requiredRole || isMakeup || !clientSchedules.length || scheduleTimesForWeekday.includes(s.time_slot))
                .map(s => {
                  const t = s.time_slot;
                  // A schedule-locked time is always with one specific
                  // therapist, not a "pick from N free" situation, the name
                  // is more useful here than a generic capacity count.
                  const scheduledTherapist = (!requiredRole && !isMakeup && clientSchedules.length > 0) ? scheduleTherapistByTime[t] : null;
                  // For a locked time, "full" must check THIS THERAPIST
                  // specifically, not the aggregate capacity across every
                  // therapist the client happens to have active schedules
                  // with (a client with 2 schedules would otherwise show a
                  // time as free because their OTHER therapist has room,
                  // then fail with a clash error at confirm time).
                  const avail = effectiveSlotAvailable(s, serviceType);
                  const full = scheduledTherapist
                    ? ((s.lunch_therapists || []).includes(scheduledTherapist) || (s.reservations || []).some(r => r.therapist_name === scheduledTherapist))
                    : avail <= 0;
                  const st = slotState(t);
                  const isInitialAssessment = serviceType === 'Initial Assessment';
                  const dead = full || st !== 'future';
                  const suffix = s.lunch_break ? ', lunch break' : (isInitialAssessment && s.no_admin_available) ? ', no front desk coverage' : full ? ', fully booked' : (st === 'ended' ? ', ended' : (st === 'ongoing' ? ', ongoing now' : scheduledTherapist ? ` · ${scheduledTherapist}` : (isInitialAssessment ? ', 1 slot per hour' : (s.capacity > 1 ? `, ${avail} of ${s.capacity} free` : ''))));
                  return <option key={t} value={t} disabled={dead}>{t}{suffix}</option>;
                })}
            </select>
          )}
        </div>
        <div>
          <label className="form-label">Payment Amount (₱) *</label>
          <input className="form-input" type="number" min="1" step="1" id="modal-amount" placeholder="e.g. 1400" />
        </div>
        <div style={{ gridColumn: '1/-1' }}>
          <label className="form-label">Notes (optional)</label>
          <input className="form-input" id="modal-notes" placeholder="e.g. Parent requested morning slot only" />
        </div>
        </fieldset>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={onConfirm} disabled={busy || (!!outstandingBalance && !isMakeup)}><i className="fa-solid fa-calendar-check" style={{ marginRight: 5 }} />{busy ? 'Booking…' : 'Confirm Booking'}</button>
      </div>
    </Modal>
  );
}

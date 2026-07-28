import { useState, useEffect } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { api } from '../../../../api.js';
import {
  STATUS_PILL, toMinutes, todayPH, nowPH, isOngoingReservation, isEffectivelyCompleted, effectiveStatusKey,
  minBookableDatePH, effectiveSlotAvailable, disciplineOfSessionType, DAY_NAMES, CAL_MONTH_NAMES
} from './reservationsHelpers.js';

function occurrenceLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${CAL_MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export default function SlotActionsModal({ selected, time, reservation, busy, onClose, onReschedule, onCancel, onNoShow, onEndSession }) {
  const bk = reservation;
  const clientName = bk?.clients?.full_name || 'Unknown Client';
  const therapist = bk?.therapist_name || null;
  const room = bk?.room || null;
  const duration = bk?.duration_min ? bk.duration_min + ' minutes' : null;
  const sessionType = bk?.session_type || null;
  const ongoing = isOngoingReservation(bk);
  const st = STATUS_PILL[effectiveStatusKey(bk)] || STATUS_PILL.pending;

  const isToday = selected.date === todayPH();
  const nowMinutes = (() => { const n = nowPH(); return n.getUTCHours() * 60 + n.getUTCMinutes(); })();

  // No-show/End Session are offered live, while the session is actually
  // Ongoing. A session whose time has already passed with nobody resolving
  // it live falls into needsResolution below instead, a separate retroactive
  // fix, not this same-moment flow.
  const canMarkNoShow = ongoing && ['confirmed', 'rescheduled'].includes(bk?.status);
  const canEndSession = ongoing && ['confirmed', 'rescheduled'].includes(bk?.status);
  // Time passed, raw status still confirmed/rescheduled, nobody ever told the
  // system what really happened (it just LOOKS completed by default, see
  // isEffectivelyCompleted). Staff can retroactively resolve it here, with
  // the same real consequences (fee/credit/consecutive-absence count) as
  // marking it live would have had, no time limit on how far back.
  const needsResolution = isEffectivelyCompleted(bk) && ['confirmed', 'rescheduled'].includes(bk?.status);
  // A booking that's already reached a terminal outcome, or has effectively
  // completed (its time ended with nobody marking it Completed/No-Show), can't
  // be cancelled anymore, there's nothing left to free up. Same for a session
  // that's Ongoing right now, cancelling only makes sense before a session
  // happens, once it's actually in progress the only real outcomes left are
  // End Session or No-Show, not "this isn't happening" (see canMarkNoShow/canEndSession above).
  const canCancel = !ongoing && !['cancelled', 'declined', 'completed', 'no_show'].includes(bk?.status) && !isEffectivelyCompleted(bk);

  // Reschedule can move to a different DAY, not just a different time slot the
  // same day, a missed/no-show session especially often needs a whole new day.
  // Defaults to this booking's own current date, options for every date
  // (including the current one) are fetched fresh scoped to THIS booking's own
  // `sessionType`, not the calendar page's `daySlots` prop, that prop is fetched
  // for whatever service-type filter the admin has the calendar set to (which
  // can be a different type entirely, or the "All Types" overview with no
  // per-discipline coverage flags at all), reusing it here could offer a slot
  // that server-side validation then rejects.
  const [rescheduleDate, setRescheduleDate] = useState(selected.date);
  const [rescheduleSlots, setRescheduleSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [newTime, setNewTime] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSlotsLoading(true);
    setNewTime('');
    const qs = 'date=' + rescheduleDate + (bk?.client_id ? '&client_id=' + bk.client_id : '') + (sessionType ? '&session_type=' + encodeURIComponent(sessionType) : '');
    api('/reservations/slots?' + qs)
      .then(data => { if (!cancelled) setRescheduleSlots(data || []); })
      .catch(() => { if (!cancelled) setRescheduleSlots([]); })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rescheduleDate]);

  // A session booked into a fixed recurring schedule can only be rescheduled
  // to one of that client's own assigned day/times for this discipline, not
  // any open slot, moving it off-schedule would defeat the whole point of a
  // fixed slot (mirrors the same lock server-side, see PUT /reservations/:id).
  // A make-up session was never on the fixed schedule to begin with, it stays
  // free to move to any open gap.
  const isLockedToSchedule = !!bk?.recurring_schedule_id && !bk?.is_makeup;
  const [clientSchedules, setClientSchedules] = useState([]);
  useEffect(() => {
    const discipline = disciplineOfSessionType(sessionType);
    if (!isLockedToSchedule || !bk?.client_id || !discipline) { setClientSchedules([]); return; }
    let cancelled = false;
    api('/reservations/' + bk.client_id + '/schedules')
      .then(list => { if (!cancelled) setClientSchedules((list || []).filter(s => s.status === 'active' && s.discipline === (discipline === 'speech' ? 'Speech' : 'OT'))); })
      .catch(() => { if (!cancelled) setClientSchedules([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLockedToSchedule, bk?.client_id, sessionType]);

  const rescheduleWeekday = new Date(rescheduleDate + 'T00:00:00Z').getUTCDay();

  // The ONE exact schedule this reservation is pinned to, not any of the
  // client's other active schedules for this discipline (a client recommended
  // 2x/week has 2 different therapists, but each is its own fixed commitment,
  // never interchangeable with the other via reschedule), mirrors the same
  // restriction server-side, see PUT /reservations/:id.
  const homeSchedule = clientSchedules.find(s => s.id === bk?.recurring_schedule_id) || null;
  const scheduleTimesForWeekday = homeSchedule && homeSchedule.day_of_week === rescheduleWeekday ? [homeSchedule.time_slot] : [];

  // A native <input type="date"> can only enforce a continuous min/max range,
  // it has no way to restrict picking to just every 7th day, so its calendar
  // would still let staff click a Tuesday even though only this schedule's
  // exact weekday is ever valid (the error message below caught that AFTER
  // the fact, but never should have been clickable in the first place). For a
  // locked schedule, list only the schedule's own real future occurrences
  // instead, each checked against real availability, greyed out if already
  // booked (present in Adjust & Cancel Schedules, or otherwise filled).
  const [scheduleOccurrences, setScheduleOccurrences] = useState([]); // [{ date, available }]
  const [autoSearching, setAutoSearching] = useState(false);
  useEffect(() => {
    if (!isLockedToSchedule || !homeSchedule) return;
    let cancelled = false;
    setAutoSearching(true);
    setScheduleOccurrences([]);
    (async () => {
      const base = new Date(selected.date + 'T00:00:00Z');
      const occurrences = [];
      let firstAvailable = null;
      for (let weeksAhead = 1; weeksAhead <= 16 && !cancelled; weeksAhead++) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + weeksAhead * 7);
        const candidate = d.toISOString().slice(0, 10);
        let available = false;
        try {
          // Scoped to this schedule's own therapist explicitly, not just
          // client_id - a 2-schedule client (e.g. 2x/week with 2 different
          // therapists) would otherwise report a date "available" because the
          // OTHER therapist has room, even when this specific one doesn't.
          const data = await api('/reservations/slots?date=' + candidate + '&client_id=' + bk.client_id + '&therapist_name=' + encodeURIComponent(homeSchedule.therapist_name) + '&session_type=' + encodeURIComponent(sessionType));
          const slot = (data || []).find(s => s.time_slot === homeSchedule.time_slot);
          available = !!slot && effectiveSlotAvailable(slot, sessionType) > 0;
        } catch { /* treat as unavailable, still list it so staff sees why */ }
        occurrences.push({ date: candidate, available });
        if (available && !firstAvailable) firstAvailable = candidate;
        if (!cancelled) setScheduleOccurrences([...occurrences]);
      }
      if (!cancelled && firstAvailable) { setRescheduleDate(firstAvailable); setNewTime(homeSchedule.time_slot); }
    })().finally(() => { if (!cancelled) setAutoSearching(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLockedToSchedule, homeSchedule?.id]);

  const rescheduleIsToday = rescheduleDate === todayPH();
  const rescheduleOpts = rescheduleSlots.filter(s => {
    if (rescheduleDate === selected.date && s.time_slot === time) return false;
    if (effectiveSlotAvailable(s, sessionType) <= 0) return false;
    if (rescheduleIsToday && toMinutes(s.time_slot) <= nowMinutes) return false;
    if (isLockedToSchedule && homeSchedule && !scheduleTimesForWeekday.includes(s.time_slot)) return false;
    return true;
  }).map(s => s.time_slot);

  return (
    <Modal title={'Manage Booking: ' + time} onClose={onClose} width={540}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 9, background: '#F0F9FF', border: '1px solid #BAE6FD', marginBottom: 18 }}>
        <i className="fa-solid fa-calendar-check" style={{ color: 'var(--color-primary)', fontSize: 18 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{clientName} <span className={'pill ' + st.cls} style={{ fontSize: 10, marginLeft: 6 }}>{st.label}</span></div>
          <div style={{ fontSize: 12, color: '#64748B' }}>{selected.label}, {selected.year} · {time}{duration ? ' · ' + duration : ''}</div>
          {sessionType && <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>{sessionType}{therapist ? ' · ' + therapist : ''}{room ? ' · ' + room : ''}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {needsResolution && (
          <div style={{ padding: 14, borderRadius: 10, border: '1px solid #FDE68A', background: '#FFFBEB' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#92400E', marginBottom: 8 }}><i className="fa-solid fa-clock-rotate-left" style={{ marginRight: 7 }} />This session's time already passed, unresolved</div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>
              Nobody marked what actually happened while it was ongoing (it's shown as Completed by default, but that was never confirmed). Resolve it now, with the same real consequences as if it were done live.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-success)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1 }} disabled={busy} onClick={() => onEndSession(bk.id)}>
                <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-circle-check')} style={{ marginRight: 5 }} />It Happened Normally
              </button>
              <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1 }} disabled={busy} onClick={() => onNoShow(bk.id, false)}>
                <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-user-slash')} style={{ marginRight: 5 }} />Unexcused No-Show
              </button>
              <button style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #CBD5E1', background: '#fff', fontSize: 12.5, fontWeight: 600, color: '#334155', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1 }} disabled={busy} onClick={() => onNoShow(bk.id, true)}>
                <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-circle-check')} style={{ marginRight: 5 }} />Excused No-Show
              </button>
            </div>
          </div>
        )}
        {canCancel && (
        <div style={{ padding: 14, borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}><i className="fa-solid fa-arrows-rotate" style={{ color: 'var(--color-primary)', marginRight: 7 }} />Reschedule to a different date &amp; time</div>
          {isLockedToSchedule && homeSchedule && (
            <div style={{ fontSize: 11.5, color: '#0D9488', marginBottom: 10 }}>
              <i className="fa-solid fa-calendar-week" style={{ marginRight: 5 }} />
              Fixed schedule: {DAY_NAMES[homeSchedule.day_of_week]}s at {homeSchedule.time_slot} with {homeSchedule.therapist_name}. A weekly slot only has room for one occurrence per week, so this can only move to a FUTURE week's occurrence of that same day/time/therapist, or book a make-up session instead for a one-off change this week.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: rescheduleOpts.length || slotsLoading || autoSearching ? 10 : 0 }}>
            {isLockedToSchedule && homeSchedule ? (
              <select
                className="form-select" style={{ flex: 1, minWidth: 150 }}
                value={rescheduleDate} onChange={e => setRescheduleDate(e.target.value)}
              >
                {!scheduleOccurrences.length && <option value={rescheduleDate}>Loading available dates…</option>}
                {scheduleOccurrences.map(o => (
                  <option key={o.date} value={o.date} disabled={!o.available}>
                    {occurrenceLabel(o.date)}{o.available ? '' : ' (already booked)'}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="date" className="form-input" style={{ flex: 1, minWidth: 150 }}
                min={minBookableDatePH()} value={rescheduleDate}
                onChange={e => e.target.value && setRescheduleDate(e.target.value)}
              />
            )}
          </div>
          {autoSearching && !scheduleOccurrences.length ? (
            <div style={{ fontSize: 12, color: '#94A3B8', padding: '8px 0' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Checking availability for upcoming weeks…</div>
          ) : autoSearching && !scheduleOccurrences.some(o => o.available) ? (
            <div style={{ fontSize: 12, color: '#94A3B8', padding: '8px 0' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Still checking further weeks for an open one…</div>
          ) : slotsLoading ? (
            <div style={{ fontSize: 12, color: '#94A3B8', padding: '8px 0' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Checking availability for that day…</div>
          ) : !rescheduleOpts.length ? (
            <div style={{ fontSize: 12, color: 'var(--color-danger)', padding: '8px 0' }}>
              <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />
              {isLockedToSchedule && homeSchedule && !scheduleTimesForWeekday.length
                ? `This session's fixed schedule is ${DAY_NAMES[homeSchedule.day_of_week]}s at ${homeSchedule.time_slot} with ${homeSchedule.therapist_name}, pick a ${DAY_NAMES[homeSchedule.day_of_week]} above.`
                : 'No available time slots on this day.'}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select className="form-select" style={{ flex: 1, minWidth: 130 }} value={newTime} onChange={e => setNewTime(e.target.value)}>
                <option value="">- Select new time -</option>
                {rescheduleOpts.map(t2 => <option key={t2} value={t2}>{t2}</option>)}
              </select>
              <button className="btn-primary" style={{ padding: '8px 14px', fontSize: 12, whiteSpace: 'nowrap' }} disabled={busy || !newTime} onClick={() => onReschedule(bk.id, rescheduleDate, newTime)}>
                <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-arrows-rotate')} style={{ marginRight: 5 }} />{busy ? 'Rescheduling…' : 'Confirm Reschedule'}
              </button>
            </div>
          )}
        </div>
        )}
        {canEndSession && (
          <div style={{ padding: 14, borderRadius: 10, border: '1px solid #DDD6FE', background: '#F5F3FF' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--cat-5)', marginBottom: 8 }}><i className="fa-solid fa-hourglass-half" style={{ marginRight: 7 }} />Ongoing</div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>This session is ongoing right now. End it once it's finished to mark it complete.</div>
            <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--cat-5)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1 }} disabled={busy} onClick={() => onEndSession(bk.id)}>
              <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-flag-checkered')} style={{ marginRight: 5 }} />{busy ? 'Ending…' : 'End Session'}
            </button>
          </div>
        )}
        {canMarkNoShow && (
          <div style={{ padding: 14, borderRadius: 10, border: '1px solid #FECACA', background: '#FEF2F2' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-danger)', marginBottom: 8 }}><i className="fa-solid fa-user-slash" style={{ marginRight: 7 }} />Client didn't show up</div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>
              Unexcused adds a ₱500 no-show fee. Excused charges nothing, and if this session was already paid, that payment carries forward to their next session.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1 }} disabled={busy} onClick={() => onNoShow(bk.id, false)}>
                <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-user-slash')} style={{ marginRight: 5 }} />Unexcused (fee)
              </button>
              <button style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #CBD5E1', background: '#fff', fontSize: 12.5, fontWeight: 600, color: '#334155', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1 }} disabled={busy} onClick={() => onNoShow(bk.id, true)}>
                <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-circle-check')} style={{ marginRight: 5 }} />Excused (no fee)
              </button>
            </div>
          </div>
        )}
        {canCancel && (
          <div style={{ padding: 14, borderRadius: 10, border: '1px solid #FECACA', background: '#FEF2F2' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-danger)', marginBottom: 8 }}><i className="fa-solid fa-calendar-xmark" style={{ marginRight: 7 }} />Cancel this booking</div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>This will mark the booking as cancelled and free up the slot for a new reservation.</div>
            {confirmingCancel ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-danger)' }}>Are you sure?</span>
                <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? .7 : 1 }} disabled={busy} onClick={() => onCancel(bk.id)}>
                  <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-trash')} style={{ marginRight: 5 }} />{busy ? 'Cancelling…' : 'Yes, Cancel'}
                </button>
                <button className="btn-secondary" style={{ padding: '8px 18px', fontSize: 12.5 }} disabled={busy} onClick={() => setConfirmingCancel(false)}>Never Mind</button>
              </div>
            ) : (
              <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }} onClick={() => setConfirmingCancel(true)}>
                <i className="fa-solid fa-trash" style={{ marginRight: 5 }} />Cancel Booking
              </button>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

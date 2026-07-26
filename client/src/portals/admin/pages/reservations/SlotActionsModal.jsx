import { useState, useEffect } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { api } from '../../../../api.js';
import {
  STATUS_PILL, toMinutes, todayPH, nowPH, isOngoingReservation, isEffectivelyCompleted, effectiveStatusKey,
  minBookableDatePH, effectiveSlotAvailable
} from './reservationsHelpers.js';

export default function SlotActionsModal({ selected, daySlots, time, reservation, busy, onClose, onReschedule, onCancel, onNoShow, onEndSession }) {
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

  // No-show is only offered while the session is actually Ongoing right now,
  // not before it starts and not after it's already over, staff decide this
  // in the moment the client fails to show up, not as an after-the-fact edit.
  const canMarkNoShow = ongoing && ['confirmed', 'rescheduled'].includes(bk?.status);
  const canEndSession = ongoing && ['confirmed', 'rescheduled'].includes(bk?.status);
  // A booking that's already reached a terminal outcome, or has effectively
  // completed (its time ended with nobody marking it Completed/No-Show), can't
  // be cancelled anymore, there's nothing left to free up.
  const canCancel = !['cancelled', 'declined', 'completed', 'no_show'].includes(bk?.status) && !isEffectivelyCompleted(bk);

  // Reschedule can move to a different DAY, not just a different time slot the
  // same day, a missed/no-show session especially often needs a whole new day.
  // Defaults to this booking's own current date, options for the chosen date
  // are fetched fresh (real therapist shift/lunch/holiday-aware availability,
  // same engine every booking uses), same day's slots reuse the already-loaded
  // `daySlots` prop instead of a redundant refetch.
  const [rescheduleDate, setRescheduleDate] = useState(selected.date);
  const [rescheduleSlots, setRescheduleSlots] = useState(daySlots);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [newTime, setNewTime] = useState('');

  useEffect(() => {
    if (rescheduleDate === selected.date) { setRescheduleSlots(daySlots); return; }
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

  const rescheduleIsToday = rescheduleDate === todayPH();
  const rescheduleOpts = rescheduleSlots.filter(s => {
    if (rescheduleDate === selected.date && s.time_slot === time) return false;
    if (effectiveSlotAvailable(s, sessionType) <= 0) return false;
    if (rescheduleIsToday && toMinutes(s.time_slot) <= nowMinutes) return false;
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
        <div style={{ padding: 14, borderRadius: 10, border: '1px solid #E2E8F0', background: '#F8FAFC' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}><i className="fa-solid fa-arrows-rotate" style={{ color: 'var(--color-primary)', marginRight: 7 }} />Reschedule to a different date &amp; time</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: rescheduleOpts.length || slotsLoading ? 10 : 0 }}>
            <input
              type="date" className="form-input" style={{ flex: 1, minWidth: 150 }}
              min={minBookableDatePH()} value={rescheduleDate}
              onChange={e => e.target.value && setRescheduleDate(e.target.value)}
            />
          </div>
          {slotsLoading ? (
            <div style={{ fontSize: 12, color: '#94A3B8', padding: '8px 0' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Checking availability for that day…</div>
          ) : !rescheduleOpts.length ? (
            <div style={{ fontSize: 12, color: 'var(--color-danger)', padding: '8px 0' }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />No available time slots on this day.</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select className="form-select" style={{ flex: 1, minWidth: 130 }} value={newTime} onChange={e => setNewTime(e.target.value)}>
                <option value="">- Select new time -</option>
                {rescheduleOpts.map(t2 => <option key={t2} value={t2}>{t2}</option>)}
              </select>
              <button className="btn-primary" style={{ padding: '8px 14px', fontSize: 12, whiteSpace: 'nowrap' }} disabled={busy || !newTime} onClick={() => onReschedule(bk.id, rescheduleDate, newTime)}>
                <i className="fa-solid fa-arrows-rotate" style={{ marginRight: 5 }} />Confirm Reschedule
              </button>
            </div>
          )}
        </div>
        {canEndSession && (
          <div style={{ padding: 14, borderRadius: 10, border: '1px solid #DDD6FE', background: '#F5F3FF' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--cat-5)', marginBottom: 8 }}><i className="fa-solid fa-hourglass-half" style={{ marginRight: 7 }} />Ongoing</div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>This session is ongoing right now. End it once it's finished to mark it complete.</div>
            <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--cat-5)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }} disabled={busy} onClick={() => onEndSession(bk.id)}>
              <i className="fa-solid fa-flag-checkered" style={{ marginRight: 5 }} />End Session
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
              <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }} disabled={busy} onClick={() => onNoShow(bk.id, false)}>
                <i className="fa-solid fa-user-slash" style={{ marginRight: 5 }} />Unexcused (fee)
              </button>
              <button style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #CBD5E1', background: '#fff', fontSize: 12.5, fontWeight: 600, color: '#334155', cursor: 'pointer' }} disabled={busy} onClick={() => onNoShow(bk.id, true)}>
                <i className="fa-solid fa-circle-check" style={{ marginRight: 5 }} />Excused (no fee)
              </button>
            </div>
          </div>
        )}
        {canCancel && (
          <div style={{ padding: 14, borderRadius: 10, border: '1px solid #FECACA', background: '#FEF2F2' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--color-danger)', marginBottom: 8 }}><i className="fa-solid fa-calendar-xmark" style={{ marginRight: 7 }} />Cancel this booking</div>
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>This will mark the booking as cancelled and free up the slot for a new reservation.</div>
            <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }} disabled={busy} onClick={() => onCancel(bk.id)}>
              <i className="fa-solid fa-trash" style={{ marginRight: 5 }} />Cancel Booking
            </button>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

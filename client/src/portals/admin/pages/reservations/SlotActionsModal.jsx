import { Modal } from '../../../../components/ui.jsx';
import { STATUS_PILL, toMinutes, todayPH, nowPH, isOngoingReservation, isEffectivelyCompleted, effectiveStatusKey } from './reservationsHelpers.js';

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

  const rescheduleOpts = daySlots.filter(s => {
    if (s.time_slot === time) return false;
    if (s.available <= 0) return false;
    if (isToday && toMinutes(s.time_slot) <= nowMinutes) return false;
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
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 10 }}><i className="fa-solid fa-arrows-rotate" style={{ color: 'var(--color-primary)', marginRight: 7 }} />Reschedule to a different time</div>
          {!rescheduleOpts.length && (
            <div style={{ fontSize: 12, color: 'var(--color-danger)', padding: '8px 0' }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />No available future time slots on this day.</div>
          )}
          {!!rescheduleOpts.length && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <select className="form-select" id="reschedule-new-time" style={{ flex: 1, minWidth: 130 }} defaultValue="">
                <option value="">- Select new time -</option>
                {rescheduleOpts.map(t2 => <option key={t2} value={t2}>{t2}</option>)}
              </select>
              <button className="btn-primary" style={{ padding: '8px 14px', fontSize: 12, whiteSpace: 'nowrap' }} disabled={busy} onClick={() => onReschedule(bk.id, time)}>
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
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 10 }}>This session is ongoing right now. Mark it as a no-show, it'll count against attendance and won't hold the slot.</div>
            <button style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: 'var(--color-danger-strong)', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }} disabled={busy} onClick={() => onNoShow(bk.id)}>
              <i className="fa-solid fa-user-slash" style={{ marginRight: 5 }} />Mark as No-Show
            </button>
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

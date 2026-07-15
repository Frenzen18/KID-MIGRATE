import { useEffect, useState } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { api } from '../../../../api.js';
import { defaultRateFor } from './reservationsHelpers.js';

export default function BookingModal({ selected, daySlots, slotState, defaultTime, time, clients, clientLabel, busy, onClose, onConfirm }) {
  // Once a client is picked, re-fetch slots scoped to their Assigned Therapist
  // (if any) so the Time Slot list only shows that therapist's actual shift
  // hours instead of the whole clinic's combined capacity.
  const [selectedClientId, setSelectedClientId] = useState('');
  const [scopedSlots, setScopedSlots] = useState(daySlots);
  useEffect(() => {
    if (!selectedClientId) { setScopedSlots(daySlots); return; }
    let cancelled = false;
    api('/reservations/slots?date=' + selected.date + '&client_id=' + selectedClientId)
      .then(data => { if (!cancelled) setScopedSlots(data); })
      .catch(() => { if (!cancelled) setScopedSlots(daySlots); });
    return () => { cancelled = true; };
  }, [selectedClientId, selected.date, daySlots]);

  return (
    <Modal title={'Book Slot: ' + selected.label + ', ' + selected.year} onClose={onClose} width={540}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9, background: '#F0F9FF', border: '1px solid #BAE6FD', marginBottom: 16 }}>
        <i className="fa-solid fa-calendar-day" style={{ color: '#0EA5E9', fontSize: 16 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{selected.label}, {selected.year}</div>
          <div style={{ fontSize: 11.5, color: '#64748B' }}>{time ? 'Time slot: ' + time : 'Select a time slot below'}</div>
        </div>
      </div>
      <div id="bk-err" style={{ display: 'none', background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 14 }}>
        <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} /><span id="bk-err-msg" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1/-1' }}>
          <label className="form-label">Client *</label>
          <select className="form-select" id="modal-client-select" defaultValue=""
            onChange={e => {
              const c = clients.find(cl => clientLabel(cl) === e.target.value);
              const amt = document.getElementById('modal-amount');
              if (amt && c) amt.value = defaultRateFor(c);
              setSelectedClientId(c ? c.id : '');
            }}>
            <option value="">- Select client -</option>
            {clients.map(c => <option key={c.id} value={clientLabel(c)}>{clientLabel(c)}</option>)}
          </select>
          {(() => {
            const c = clients.find(cl => cl.id === selectedClientId);
            return c?.assigned_therapist_name
              ? <div style={{ fontSize: 11.5, color: '#0EA5E9', marginTop: 5 }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Showing available times for {c.assigned_therapist_name}'s schedule only.</div>
              : null;
          })()}
        </div>
        <div>
          <label className="form-label">Session Date</label>
          <input className="form-input" type="date" value={selected.date} readOnly style={{ background: '#F1F5F9', fontWeight: 600 }} />
        </div>
        <div>
          <label className="form-label">Start Time *</label>
          <select className="form-select" id="modal-time-select" defaultValue={defaultTime}>
            {scopedSlots.map(s => {
              const t = s.time_slot;
              const full = s.available <= 0;
              const st = slotState(t);
              const dead = full || st !== 'future';
              const suffix = full ? ', fully booked' : (st === 'ended' ? ', ended' : (st === 'ongoing' ? ', ongoing now' : (s.capacity > 1 ? `, ${s.available} of ${s.capacity} free` : '')));
              return <option key={t} value={t} disabled={dead}>{t}{suffix}</option>;
            })}
          </select>
        </div>
        <div>
          <label className="form-label">Payment Amount (₱) *</label>
          <input className="form-input" type="number" min="1" step="1" id="modal-amount" placeholder="e.g. 1400" />
        </div>
        <div style={{ gridColumn: '1/-1' }}>
          <label className="form-label">Notes (optional)</label>
          <input className="form-input" id="modal-notes" placeholder="e.g. Parent requested morning slot only" />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={onConfirm} disabled={busy}><i className="fa-solid fa-calendar-check" style={{ marginRight: 5 }} />{busy ? 'Booking…' : 'Confirm Booking'}</button>
      </div>
    </Modal>
  );
}

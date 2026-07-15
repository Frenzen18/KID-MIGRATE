import { useState } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { fmtShort } from './reservationsHelpers.js';

const PRESET_REASONS = [
  'Please reschedule to another date',
  'Therapist unavailable on selected date',
  'Slot already taken',
  'Incomplete client information'
];

export default function DeclineModal({ reservation, busy, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [confirming, setConfirming] = useState(false);
  if (!reservation) return null;
  const dateLabel = fmtShort(reservation.date);

  if (confirming) {
    return (
      <Modal title="Are you sure?" onClose={onClose} width={440}>
        <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 22, color: '#DC2626' }}><i className="fa-solid fa-calendar-xmark" /></div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 8 }}>Decline this booking request?</div>
          <div style={{ fontSize: 13, color: '#64748B', marginBottom: 14, lineHeight: 1.6 }}>
            <strong>{reservation.clients?.full_name}</strong>, {dateLabel} · {reservation.time_slot}<br />
            This cannot be undone. The parent will see this request as declined.
          </div>
          <div style={{ textAlign: 'left', padding: '10px 14px', borderRadius: 9, background: '#F8FAFC', border: '1px solid #E2E8F0', marginBottom: 18, fontSize: 12.5, color: '#475569' }}>
            <strong>Reason:</strong> {reason.trim() || 'No reason provided'}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Go Back</button>
            <button style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: '#EF4444', fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' }} disabled={busy} onClick={() => onConfirm(reservation, reason)}>
              {busy ? 'Declining…' : 'Yes, Decline Request'}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={'Decline Request: ' + (reservation.clients?.full_name || '')} onClose={onClose} width={480}>
      <div style={{ padding: '10px 14px', borderRadius: 9, background: '#FEF2F2', border: '1px solid #FECACA', marginBottom: 16, fontSize: 13, color: '#DC2626' }}>
        <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />
        You are declining: <strong>{reservation.clients?.full_name}</strong>, {dateLabel} · {reservation.time_slot}
      </div>
      <div style={{ marginBottom: 14 }}>
        <label className="form-label">Select Reason *</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {PRESET_REASONS.map((r, i) => (
            <button key={r} type="button" className="btn-edit" style={{ textAlign: 'left', fontSize: 12, background: selectedPreset === i ? '#EFF6FF' : undefined }} onClick={() => { setSelectedPreset(i); setReason(r); }}>
              <i className={'fa-regular ' + (selectedPreset === i ? 'fa-circle-check' : 'fa-circle')} style={{ marginRight: 7, color: selectedPreset === i ? '#0EA5E9' : '#94A3B8' }} />{r}
            </button>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label className="form-label">Or type a custom reason</label>
        <input className="form-input" placeholder="Type reason here…" value={reason} onChange={e => { setReason(e.target.value); setSelectedPreset(null); }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: '#EF4444', fontSize: 12.5, fontWeight: 600, color: '#fff', cursor: 'pointer' }} disabled={busy} onClick={() => setConfirming(true)}>
          <i className="fa-solid fa-xmark" style={{ marginRight: 5 }} />Decline Request
        </button>
      </div>
    </Modal>
  );
}

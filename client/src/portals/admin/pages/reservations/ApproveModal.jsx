import { useState } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { fmtShort, rateForSessionType } from './reservationsHelpers.js';

/** Shown when staff approve a parent-submitted request, lets them see and
 *  set the invoice price before the booking (and its auto-invoice) are
 *  created. Payment method isn't picked here, nothing's been paid yet at
 *  approval time, so the invoice always starts Unpaid/pending; the method
 *  gets recorded later, in the Payments module, once someone actually pays it. */
export default function ApproveModal({ reservation, busy, onClose, onConfirm }) {
  const [amount, setAmount] = useState(() => String(rateForSessionType(reservation?.session_type)));
  if (!reservation) return null;
  const dateLabel = fmtShort(reservation.date);
  const amt = Number(amount);
  const valid = Number.isFinite(amt) && amt > 0;

  return (
    <Modal title={'Approve Request: ' + (reservation.clients?.full_name || '')} onClose={onClose} width={480}>
      <div style={{ padding: '10px 14px', borderRadius: 9, background: '#F0FDF4', border: '1px solid #DCFCE7', marginBottom: 16, fontSize: 13, color: '#166534' }}>
        <i className="fa-solid fa-circle-check" style={{ marginRight: 6 }} />
        Approving: <strong>{reservation.clients?.full_name}</strong>, {dateLabel} · {reservation.time_slot} · {reservation.session_type}
      </div>
      <div style={{ marginBottom: 16 }}>
        <label className="form-label">Payment Amount (₱) *</label>
        <input className="form-input" type="number" min="1" step="1" value={amount} onChange={e => setAmount(e.target.value)} />
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>Invoice is created as Unpaid, the payment method is recorded later, in Payments, once it's actually paid.</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" disabled={busy || !valid} onClick={() => onConfirm(reservation, amt)}>
          <i className="fa-solid fa-circle-check" style={{ marginRight: 5 }} />{busy ? 'Approving…' : 'Approve & Set Payment'}
        </button>
      </div>
    </Modal>
  );
}

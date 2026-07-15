import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';

const REASONS = ['Session cancelled by client', 'Duplicate payment', 'Billing error', 'Other'];

export default function RefundModal({ data, closeModal, toast }) {
  const [refundBusy, setRefundBusy] = useState(false);
  const submitRefund = async () => {
    if (refundBusy) return; // guards against a double-click firing two refund requests
    const reasonSel = document.getElementById('refund-reason')?.value;
    const other = document.getElementById('refund-reason-other')?.value?.trim();
    const reason = reasonSel === 'Other' ? other : reasonSel;
    if (!reason) { toast('Please provide a refund reason', 'fa-triangle-exclamation'); return; }
    setRefundBusy(true);
    const ok = data.onSave ? await data.onSave(reason) : true;
    setRefundBusy(false);
    if (ok !== false) closeModal();
  };
  return (
    <Modal title="Process Refund" onClose={closeModal} width={440}>
      <div style={{ marginBottom: 14 }}><label className="form-label">Invoice</label><input type="text" className="form-input" defaultValue={data.invoiceNo || data.paymentId || ''} readOnly style={{ background: '#F1F5F9' }} /></div>
      <div style={{ marginBottom: 14 }}><label className="form-label">Refund Amount</label><input type="text" className="form-input" defaultValue={data.amount != null ? '₱' + Number(data.amount).toLocaleString() : ''} readOnly style={{ background: '#F1F5F9' }} /></div>
      <div style={{ marginBottom: 20 }}>
        <label className="form-label">Reason</label>
        <select className="form-select" id="refund-reason" defaultValue={REASONS[0]}>
          {REASONS.map(r => <option key={r}>{r}</option>)}
        </select>
        <input type="text" className="form-input" id="refund-reason-other" placeholder="If Other, describe the reason…" style={{ marginTop: 8 }} />
      </div>
      <div style={{ marginBottom: 20, padding: '10px 13px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 12, color: '#991B1B' }}>
        <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />This also cancels the linked session (freeing the slot) and notifies the parent by email and in-app notification.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn-secondary" onClick={closeModal} disabled={refundBusy}>Cancel</button><button className="btn-primary" style={{ background: '#EF4444', borderColor: '#EF4444' }} onClick={submitRefund} disabled={refundBusy}>{refundBusy ? 'Processing…' : 'Process Refund'}</button></div>
    </Modal>
  );
}

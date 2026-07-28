import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';

export default function DeleteClientModal({ data, closeModal }) {
  const [busy, setBusy] = useState(false);
  // onConfirm is async and reports its own success/error toast once the delete
  // actually resolves, toasting a hardcoded "success" message here too would
  // fire before the request even completes, a false positive if it later fails.
  // Stays open with a spinner until it settles, instead of closing optimistically.
  async function confirm() {
    const cb = data.onConfirm;
    if (!cb) return closeModal();
    setBusy(true);
    try {
      await cb();
      closeModal();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={<><i className="fa-solid fa-box-archive" style={{ color: 'var(--color-warning)', marginRight: 8 }} />Archive Client Profile</>} onClose={busy ? undefined : closeModal} width={440}>
      <div style={{ textAlign: 'center', padding: '10px 0 20px' }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--color-warning-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 22, color: 'var(--color-warning)' }}><i className="fa-solid fa-box-archive" /></div>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 8 }}>Archive "{data.name || 'this client'}"?</div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>This drops the client off the Client Records list and out of progress charts, but their profile and all associated records stay on file.</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="btn-secondary" disabled={busy} onClick={closeModal}>Cancel</button>
          <button style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: 'var(--color-warning)', fontSize: 13, fontWeight: 600, color: '#fff', cursor: busy ? 'default' : 'pointer', opacity: busy ? .8 : 1 }} disabled={busy} onClick={confirm}>
            <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-box-archive')} style={{ marginRight: 6 }} />{busy ? 'Archiving…' : 'Archive Profile'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

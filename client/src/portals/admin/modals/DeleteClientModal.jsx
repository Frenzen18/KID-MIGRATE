import { Modal } from '../../../components/ui.jsx';

export default function DeleteClientModal({ data, closeModal, toast }) {
  const confirm = (msg, icon) => { const cb = data.onConfirm; closeModal(); if (cb) cb(); if (msg) toast(msg, icon); };
  return (
    <Modal title={<><i className="fa-solid fa-box-archive" style={{ color: '#B45309', marginRight: 8 }} />Archive Client Profile</>} onClose={closeModal} width={440}>
      <div style={{ textAlign: 'center', padding: '10px 0 20px' }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, background: '#FEF9C3', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 22, color: '#B45309' }}><i className="fa-solid fa-box-archive" /></div>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 8 }}>Archive "{data.name || 'this client'}"?</div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>This drops the client off the Client Records list and out of progress charts, but their profile and all associated records stay on file.</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: '#F59E0B', fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' }} onClick={() => confirm('Client profile archived', 'fa-box-archive')}>Archive Profile</button></div>
      </div>
    </Modal>
  );
}

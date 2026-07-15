import { Modal } from '../../../components/ui.jsx';

export default function DeleteUserModal({ data, closeModal, toast }) {
  const confirm = (msg, icon) => { const cb = data.onConfirm; closeModal(); if (cb) cb(); if (msg) toast(msg, icon); };
  return (
    <Modal title={<><i className="fa-solid fa-triangle-exclamation" style={{ color: '#EF4444', marginRight: 8 }} />Delete User</>} onClose={closeModal} width={440}>
      <p style={{ fontSize: 13.5, color: '#475569', margin: '0 0 10px' }}>You are about to permanently delete:</p>
      <div style={{ padding: '10px 13px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, marginBottom: 14, fontSize: 13, color: '#0F172A', fontWeight: 600 }}>
        {data.name || 'this user'} {data.id && <span style={{ fontWeight: 400, color: '#64748B' }}>({data.id})</span>}
      </div>
      <div style={{ padding: '11px 13px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, marginBottom: 18, fontSize: 12.5, color: '#991B1B' }}>
        <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />All session records and audit logs tied to this account will be permanently erased. This cannot be undone.
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" style={{ background: '#EF4444', borderColor: '#EF4444' }} onClick={() => confirm('User deleted', 'fa-trash')}><i className="fa-solid fa-trash" style={{ marginRight: 6 }} />Delete User</button></div>
    </Modal>
  );
}

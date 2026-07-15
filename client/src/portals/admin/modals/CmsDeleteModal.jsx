import { Modal } from '../../../components/ui.jsx';

const LABELS = { article: 'post', announcement: 'announcement', image: 'image' };

export default function CmsDeleteModal({ data, closeModal, toast }) {
  const confirm = (msg, icon) => { const cb = data.onConfirm; closeModal(); if (cb) cb(); if (msg) toast(msg, icon); };
  const label = LABELS[data.type] || 'item';
  const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
  const title = data.title || '';
  return (
    <Modal title={'Delete ' + labelCap} onClose={closeModal} width={440}>
      <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, background: '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 22, color: '#DC2626' }}><i className="fa-solid fa-trash" /></div>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 8 }}>Delete "{title}"?</div>
        <div style={{ fontSize: 13, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>This will remove the {label} from the public website. This action cannot be undone.</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: '#EF4444', fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' }} onClick={() => confirm('Deleted: ' + title, 'fa-trash')}>Delete Permanently</button></div>
      </div>
    </Modal>
  );
}

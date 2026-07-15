import { Modal } from '../../../components/ui.jsx';

export default function CmsEditAnnouncementModal({ data, closeModal, toast }) {
  return (
    <Modal title="Edit Announcement" onClose={closeModal} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div><label className="form-label">Title</label><input id="ann-title-inp" className="form-input" defaultValue={data.title || 'Clinic Hours: Holiday Schedule'} /></div>
        <div><label className="form-label">Message</label>
          <textarea className="form-input" rows="4" style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }} defaultValue="Updated clinic hours for the upcoming holiday week. OT and Speech sessions available Mon–Fri, 8 AM – 5 PM." />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label className="form-label">Stop showing on</label><input className="form-input" type="date" defaultValue="2026-07-07" /></div>
          <div><label className="form-label">Status</label>
            <select className="form-select" defaultValue="Published"><option>Published</option><option>Draft</option></select>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={closeModal}>Cancel</button>
          <button className="btn-primary" onClick={() => { closeModal(); toast('Announcement updated!', 'fa-check'); }}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Save Changes</button>
        </div>
      </div>
    </Modal>
  );
}

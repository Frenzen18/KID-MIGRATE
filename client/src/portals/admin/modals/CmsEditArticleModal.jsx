import { Modal } from '../../../components/ui.jsx';

export default function CmsEditArticleModal({ data, closeModal, toast }) {
  return (
    <Modal title="Edit Post" onClose={closeModal} width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div><label className="form-label">Title</label><input id="edit-title-inp" className="form-input" defaultValue={data.title || 'New Speech Therapy Program Launched'} /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label className="form-label">Category</label>
            <select className="form-select" defaultValue="Programs"><option>Programs</option><option>Insights</option><option>Events</option><option>Awards</option></select>
          </div>
          <div><label className="form-label">Status</label>
            <select className="form-select" defaultValue="Published"><option>Published</option><option>Draft</option><option>Archived</option></select>
          </div>
        </div>
        <div><label className="form-label">Post Text</label>
          <textarea className="form-input" rows="5" style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }} defaultValue="We are excited to announce an expanded speech therapy program with specialized sessions for early language development in toddlers and young children aged 2–8." />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
          <button className="btn-secondary" onClick={closeModal}>Cancel</button>
          <button className="btn-primary" onClick={() => { closeModal(); toast('Post updated on the website!', 'fa-floppy-disk'); }}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Save Changes</button>
        </div>
      </div>
    </Modal>
  );
}

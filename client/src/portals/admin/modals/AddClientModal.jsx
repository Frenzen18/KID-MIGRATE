import { Modal } from '../../../components/ui.jsx';

export default function AddClientModal({ data, closeModal, toast }) {
  const submitAddClient = () => {
    const first = (document.getElementById('ac-first')?.value || '').trim();
    const last = (document.getElementById('ac-last')?.value || '').trim();
    const dob = (document.getElementById('ac-dob')?.value || '').trim();
    const gender = document.getElementById('ac-gender')?.value || 'Male';
    const guardianName = (document.getElementById('ac-guardian')?.value || '').trim();
    const guardianContact = (document.getElementById('ac-contact')?.value || '').trim();
    if (!first || !dob || !guardianName) {
      toast('Please fill in all required fields', 'fa-triangle-exclamation');
      return;
    }
    const full_name = first + (last ? ' ' + last : '');
    closeModal();
    if (data.onSave) data.onSave({ full_name, dob, gender, guardian_name: guardianName, guardian_contact: guardianContact });
  };
  return (
    <Modal title={<><i className="fa-solid fa-user-plus" style={{ color: '#0EA5E9', marginRight: 8 }} />Register New Client</>} onClose={closeModal} width={440}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label className="form-label">First Name *</label><input id="ac-first" type="text" className="form-input" placeholder="e.g. Jake" /></div>
        <div><label className="form-label">Last Name *</label><input id="ac-last" type="text" className="form-input" placeholder="e.g. Lim" /></div>
        <div><label className="form-label">Date of Birth *</label><input id="ac-dob" type="date" className="form-input" /></div>
        <div><label className="form-label">Gender</label><select id="ac-gender" className="form-select"><option>Male</option><option>Female</option></select></div>
        <div><label className="form-label">Guardian Name *</label><input id="ac-guardian" type="text" className="form-input" placeholder="e.g. Maria Lim" /></div>
        <div><label className="form-label">Guardian Contact *</label><input id="ac-contact" type="text" className="form-input" placeholder="+63 9XX XXX XXXX" /></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={submitAddClient}><i className="fa-solid fa-plus" style={{ marginRight: 5 }} />Create Profile</button></div>
    </Modal>
  );
}

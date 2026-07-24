import { Modal } from '../../../components/ui.jsx';
import { filterPhoneInput, formatPhoneDisplay } from '../../../phoneInput.js';
import { sanitizeNameInput, hasInvalidNameChars, INVALID_NAME_MSG } from '../../../nameInput.js';

/** Live-filters a name field and toggles its sibling `${noteId}` warning div. */
function onNameInput(noteId) {
  return e => {
    const note = document.getElementById(noteId);
    if (note) note.style.display = hasInvalidNameChars(e.target.value) ? 'block' : 'none';
    e.target.value = sanitizeNameInput(e.target.value);
  };
}

export default function AddClientModal({ data, closeModal, toast }) {
  const submitAddClient = () => {
    const first = (document.getElementById('ac-first')?.value || '').trim();
    const last = (document.getElementById('ac-last')?.value || '').trim();
    const dob = (document.getElementById('ac-dob')?.value || '').trim();
    const gender = document.getElementById('ac-gender')?.value || 'Male';
    const guardianName = (document.getElementById('ac-guardian')?.value || '').trim();
    // The field only ever displays the formatted "+63 000 000 0000" grouping,
    // strip the spaces back out so what's actually stored is the plain digits.
    const guardianContact = (document.getElementById('ac-contact')?.value || '').trim().replace(/\s+/g, '');
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
        <div><label className="form-label">First Name *</label><input id="ac-first" type="text" className="form-input" placeholder="e.g. Jake" onInput={onNameInput('ac-first-note')} /><div id="ac-first-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Last Name *</label><input id="ac-last" type="text" className="form-input" placeholder="e.g. Lim" onInput={onNameInput('ac-last-note')} /><div id="ac-last-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Date of Birth *</label><input id="ac-dob" type="date" className="form-input" /></div>
        <div><label className="form-label">Gender</label><select id="ac-gender" className="form-select"><option>Male</option><option>Female</option></select></div>
        <div><label className="form-label">Guardian Name *</label><input id="ac-guardian" type="text" className="form-input" placeholder="e.g. Maria Lim" onInput={onNameInput('ac-guardian-note')} /><div id="ac-guardian-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Guardian Contact *</label><input id="ac-contact" type="tel" className="form-input" defaultValue="+63" placeholder="+63 000 000 0000" maxLength={16} onInput={e => { e.target.value = formatPhoneDisplay(filterPhoneInput(e.target.value)); }} /></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={submitAddClient}><i className="fa-solid fa-plus" style={{ marginRight: 5 }} />Create Profile</button></div>
    </Modal>
  );
}

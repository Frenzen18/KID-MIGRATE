import { Modal } from '../../../components/ui.jsx';
import { filterPhoneInput } from './phoneInput.js';

const ROLE_MAP = {
  'Administrator': { role: 'admin' },
  'Staff': { role: 'staff' },
  'Occupational Therapist': { role: 'ot' },
  'Speech-Language Therapist': { role: 'speech' },
  'Guardian/Caretaker': { role: 'parent' }
};

export default function AddUserModal({ data, closeModal, toast }) {
  const submitAddUser = async () => {
    const first = (document.getElementById('au-first')?.value || '').trim();
    const last = (document.getElementById('au-last')?.value || '').trim();
    const email = (document.getElementById('au-email')?.value || '').trim();
    const roleLabel = document.getElementById('au-role')?.value || '';
    const rawPhone = (document.getElementById('au-phone')?.value || '').trim();
    const password = (document.getElementById('au-password')?.value || '').trim();
    if (!first || !email || !password || !roleLabel || roleLabel === 'Select role…') {
      toast('Please fill in all required fields', 'fa-triangle-exclamation');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast('Please enter a valid email address', 'fa-triangle-exclamation');
      return;
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      toast('Password must be at least 8 characters with letters and numbers', 'fa-triangle-exclamation');
      return;
    }
    // PH mobile: accept 09XXXXXXXXX or +639XXXXXXXXX, send canonical +639…
    let phone = '';
    if (rawPhone) {
      const digits = rawPhone.replace(/\D/g, '');
      if (/^09\d{9}$/.test(digits)) phone = '+63' + digits.slice(1);
      else if (/^639\d{9}$/.test(digits)) phone = '+' + digits;
      else {
        toast('Phone must be a PH mobile number, e.g. 09171234567 or +639171234567', 'fa-triangle-exclamation');
        return;
      }
    }
    const full_name = first + (last ? ' ' + last : '');
    const { role } = ROLE_MAP[roleLabel] || { role: 'staff' };
    // Close only on success, a duplicate email/name/phone keeps the form open.
    const ok = data.onSave ? await data.onSave({ email, password, first_name: first, last_name: last, full_name, role, contact: phone }) : true;
    if (ok !== false) closeModal();
  };
  return (
    <Modal title="Add New User" onClose={closeModal} width={440}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <div><label className="form-label">First Name</label><input id="au-first" type="text" className="form-input" placeholder="e.g. Maria" /></div>
        <div><label className="form-label">Last Name</label><input id="au-last" type="text" className="form-input" placeholder="e.g. Santos" /></div>
      </div>
      <div style={{ marginBottom: 14 }}><label className="form-label">Email Address</label><input id="au-email" type="email" className="form-input" placeholder="name@kidclinic.ph" /></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <div><label className="form-label">Role</label><select id="au-role" className="form-select"><option>Select role…</option><option>Administrator</option><option>Staff</option><option>Occupational Therapist</option><option>Speech-Language Therapist</option><option>Guardian/Caretaker</option></select></div>
        <div><label className="form-label">Phone Number</label><input id="au-phone" type="tel" className="form-input" placeholder="09171234567 or +639171234567" maxLength={13} onInput={e => { e.target.value = filterPhoneInput(e.target.value); }} /></div>
      </div>
      <div style={{ marginBottom: 20 }}><label className="form-label">Temporary Password</label><input id="au-password" type="password" className="form-input" defaultValue="KID2026!" placeholder="Min. 8 characters" /><div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>Auto-filled with the clinic's default temporary password, edit if needed. User will be prompted to set their own password on first login.</div></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={submitAddUser}>Create User</button></div>
    </Modal>
  );
}

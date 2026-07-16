import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { filterPhoneInput } from './phoneInput.js';
import { passwordMeetsPolicy } from '../../../components/PasswordChecklist.jsx';

const ROLE_MAP = {
  'Administrator': { role: 'admin' },
  'Staff': { role: 'staff' },
  'Occupational Therapist': { role: 'ot' },
  'Speech-Language Therapist': { role: 'speech' },
  'Guardian/Caretaker': { role: 'parent' }
};

const DEFAULT_TEMP_PASSWORD = 'Kid@2026';

export default function AddUserModal({ data, closeModal, toast }) {
  const [password, setPassword] = useState(DEFAULT_TEMP_PASSWORD);
  // Each card's own Add User button (see Users.jsx) scopes this to its own category, a single
  // option means there's nothing to actually choose, lock it instead of making the admin pick
  // the only option from a dropdown.
  const roleOptions = data.roleOptions || Object.keys(ROLE_MAP);
  const isLocked = roleOptions.length === 1;

  const submitAddUser = async () => {
    const first = (document.getElementById('au-first')?.value || '').trim();
    const last = (document.getElementById('au-last')?.value || '').trim();
    const email = (document.getElementById('au-email')?.value || '').trim();
    const roleLabel = document.getElementById('au-role')?.value || '';
    const rawPhone = (document.getElementById('au-phone')?.value || '').trim();
    const pw = password.trim();
    if (!first || !email || !pw || !roleLabel || roleLabel === 'Select role…') {
      toast('Please fill in all required fields', 'fa-triangle-exclamation');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast('Please enter a valid email address', 'fa-triangle-exclamation');
      return;
    }
    if (!passwordMeetsPolicy(pw)) {
      toast('Password does not meet all the requirements shown below the field', 'fa-triangle-exclamation');
      return;
    }
    // The field starts pre-filled with "+63", so an untouched field reads back as just that
    // prefix with no digits, treat it the same as empty (phone is optional here).
    let phone = '';
    if (rawPhone && rawPhone !== '+63') {
      const digits = rawPhone.replace(/\D/g, '');
      if (/^09\d{9}$/.test(digits)) phone = '+63' + digits.slice(1);
      else if (/^639\d{9}$/.test(digits)) phone = '+' + digits;
      else {
        toast('Phone must be a complete PH mobile number, e.g. +639171234567', 'fa-triangle-exclamation');
        return;
      }
    }
    const full_name = first + (last ? ' ' + last : '');
    const { role } = ROLE_MAP[roleLabel] || { role: 'staff' };
    // Close only on success, a duplicate email/name/phone keeps the form open.
    const ok = data.onSave ? await data.onSave({ email, password: pw, first_name: first, last_name: last, full_name, role, contact: phone }) : true;
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
        <div>
          <label className="form-label">Role</label>
          <select id="au-role" className="form-select" disabled={isLocked} defaultValue={isLocked ? roleOptions[0] : 'Select role…'}>
            {!isLocked && <option>Select role…</option>}
            {roleOptions.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div><label className="form-label">Phone Number</label><input id="au-phone" type="tel" className="form-input" defaultValue="+63" placeholder="+639171234567" maxLength={13} onInput={e => { e.target.value = filterPhoneInput(e.target.value); }} /></div>
      </div>
      <div style={{ marginBottom: 20 }}>
        <label className="form-label">Temporary Password</label>
        <input id="au-password" type="password" className="form-input" value={password} onChange={e => setPassword(e.target.value)} placeholder="Create a temporary password" />
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>Auto-filled with the clinic's default temporary password, edit if needed. User will be prompted to set their own password on first login.</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={submitAddUser}>Create User</button></div>
    </Modal>
  );
}

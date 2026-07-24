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

const ROLE_DB_MAP = {
  'Administrator': { role: 'admin' },
  'Staff': { role: 'staff' },
  'Occupational Therapist': { role: 'ot' },
  'Speech-Language Therapist': { role: 'speech' },
  'Guardian/Caretaker': { role: 'parent' }
};

// Suspend/Deactivate/Terminate used to be three separate cards, but the server
// only ever stores one thing either way (profiles.active true/false), so all
// three did the exact same thing and were equally reversible, no matter which
// button was clicked, including "Terminate" despite its own "cannot be undone"
// copy. Collapsed to the one real action that actually exists. Labeled
// "Suspend"/"Suspended" (not "Deactivate") to match the status pill and filter
// dropdown Users.jsx already shows everywhere else for this same active=false
// state, mapProfile() always renders it back as "Suspended" once saved, a
// different label here would say one thing and then immediately show another.
const STATUS_ACCESS = {
  activate: { label: 'Active', pillClass: 'pill status-pill pill-green', style: null },
  suspend: { label: 'Suspended', pillClass: 'pill status-pill pill-red', style: null },
};
const STATUS_TOAST = {
  activate: ['Account activated, user can now log in', 'fa-circle-check'],
  suspend: ['Account suspended, user can no longer log in', 'fa-pause'],
};

export default function EditUserModal({ data, closeModal, toast }) {
  const rawName = data.name || 'Maria Santos';
  const nameNoTitle = rawName.replace(/^Dr\.\s*/, '');
  const nameParts = nameNoTitle.split(' ');
  const first = nameParts[0] || '';
  const last = nameParts.slice(1).join(' ') || '';
  // profiles.role is admin/staff/ot/speech/parent, role directly encodes discipline
  // for the two therapist options, no separate specialty field needed.
  // Guardian/Caretaker is a portal category, not a staff role, a parent account can't be
  // reassigned into a staff/therapist/admin role and vice versa, so each side only offers
  // role options within its own category.
  const isGuardian = data.role === 'Guardian/Caretaker';
  const roleOptions = isGuardian
    ? ['Guardian/Caretaker']
    : Object.keys(ROLE_DB_MAP).filter(r => r !== 'Guardian/Caretaker');
  const status = data.status || 'Active';

  const accessAction = type => {
    const s = STATUS_ACCESS[type];
    if (data.onAccess) data.onAccess(s.label, s.pillClass, s.style);
    closeModal();
    toast(STATUS_TOAST[type][0], STATUS_TOAST[type][1]);
  };

  const saveEditUser = () => {
    const firstVal = document.getElementById('ef-first').value.trim();
    const lastVal = document.getElementById('ef-last').value.trim();
    const emailVal = document.getElementById('ef-email').value.trim();
    const rawPhone = document.getElementById('ef-phone').value.trim();
    const roleVal = document.getElementById('ef-role').value;

    // The field starts pre-filled with "+63", so an untouched field reads back as just that
    // prefix with no digits, treat it the same as empty (phone is optional here).
    let phoneVal = '';
    if (rawPhone && rawPhone !== '+63') {
      const digits = rawPhone.replace(/\D/g, '');
      if (/^09\d{9}$/.test(digits)) phoneVal = '+63' + digits.slice(1);
      else if (/^639\d{9}$/.test(digits)) phoneVal = '+' + digits;
      else {
        toast('Phone number must be a complete PH mobile number, e.g. +639171234567', 'fa-triangle-exclamation');
        return;
      }
    }

    const cb = data.onSave;
    closeModal();
    if (cb) cb({ name: firstVal + (lastVal ? ' ' + lastVal : ''), email: emailVal, phone: phoneVal, ...(ROLE_DB_MAP[roleVal] || { role: 'staff' }) });
    toast('User updated successfully', 'fa-check');
  };

  return (
    <Modal title={<><i className="fa-solid fa-user-pen" style={{ color: 'var(--color-primary)', marginRight: 8 }} />Edit User{data.id ? ': ' + data.id : ''}</>} onClose={closeModal} width={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 6 }}>
        <div><label className="form-label">First Name</label><input id="ef-first" className="form-input" defaultValue={first} onInput={onNameInput('ef-first-note')} /><div id="ef-first-note" style={{ display: 'none', fontSize: 11, color: 'var(--color-danger)', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Last Name</label><input id="ef-last" className="form-input" defaultValue={last} onInput={onNameInput('ef-last-note')} /><div id="ef-last-note" style={{ display: 'none', fontSize: 11, color: 'var(--color-danger)', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Email</label><input id="ef-email" className="form-input" type="email" defaultValue={data.email || ''} /></div>
        <div><label className="form-label">Phone Number</label><input id="ef-phone" type="tel" className="form-input" placeholder="+63 000 000 0000" maxLength={16} defaultValue={formatPhoneDisplay(data.phone || '+63')} onInput={e => { e.target.value = formatPhoneDisplay(filterPhoneInput(e.target.value)); }} /></div>
        <div style={{ gridColumn: '1/-1' }}>
          <label className="form-label">Role</label>
          <select id="ef-role" className="form-select" disabled={isGuardian} defaultValue={roleOptions.includes(data.role) ? data.role : roleOptions[0]}>
            {roleOptions.map(r => <option key={r}>{r}</option>)}
          </select>
          {isGuardian && <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 5 }}>Guardian/Caretaker accounts can't be reassigned to a staff role.</div>}
        </div>
      </div>
      <div style={{ borderTop: '1px solid #F1F5F9', margin: '16px 0 14px' }} />
      <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 3, fontFamily: "'Poppins',sans-serif" }}>System Access</div>
      <div style={{ fontSize: 12, color: '#64748B', marginBottom: 14 }}>Control this user's access to the KID Clinic system.</div>

      {status !== 'Active' && (
        <div style={{ border: '1px solid #BBF7D0', borderRadius: 10, padding: '12px 14px', background: '#F0FDF4', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--color-success-bg)', color: 'var(--color-success)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="fa-solid fa-check-circle" style={{ fontSize: 13 }} /></div>
            <div><div style={{ fontSize: 13, fontWeight: 600, color: '#14532D' }}>Activate Account</div><div style={{ fontSize: 11.5, color: '#166534', marginTop: 2 }}>Restore full system access. User can log in immediately.</div></div>
          </div>
          <button onClick={() => accessAction('activate')} className="btn-edit" style={{ flexShrink: 0, borderColor: '#22C55E', background: 'var(--color-success-bg)', color: 'var(--color-success)', fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8 }}><i className="fa-solid fa-check-circle" style={{ marginRight: 4 }} />Activate</button>
        </div>
      )}

      {status === 'Active' && (
        <div style={{ border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 14px', background: '#FFFBEB', marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--color-warning-bg)', color: 'var(--color-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="fa-solid fa-pause" style={{ fontSize: 13 }} /></div>
            <div><div style={{ fontSize: 13, fontWeight: 600, color: '#92400E' }}>Suspend Account</div><div style={{ fontSize: 11.5, color: '#78350F', marginTop: 2 }}>Blocks login immediately. Nothing is deleted, an admin can reactivate any time by clicking Activate above.</div></div>
          </div>
          <button onClick={() => accessAction('suspend')} className="btn-edit" style={{ flexShrink: 0, borderColor: '#F59E0B', background: 'var(--color-warning-bg)', color: 'var(--color-warning)', fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8 }}><i className="fa-solid fa-pause" style={{ marginRight: 4 }} />Suspend</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={saveEditUser}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 6 }} />Save Changes</button></div>
    </Modal>
  );
}

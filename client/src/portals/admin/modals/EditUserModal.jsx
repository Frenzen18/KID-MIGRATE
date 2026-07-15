import { Modal } from '../../../components/ui.jsx';

const ROLE_DB_MAP = {
  'Administrator': { role: 'admin' },
  'Staff': { role: 'staff' },
  'Occupational Therapist': { role: 'ot' },
  'Speech-Language Therapist': { role: 'speech' },
  'Guardian/Caretaker': { role: 'parent' }
};

const STATUS_ACCESS = {
  activate: { label: 'Active', pillClass: 'pill status-pill pill-green', style: null },
  suspend: { label: 'Suspended', pillClass: 'pill status-pill pill-red', style: null },
  deactivate: { label: 'Deactivated', pillClass: 'pill status-pill', style: { background: '#F1F5F9', color: '#64748B' } },
  terminate: { label: 'Terminated', pillClass: 'pill status-pill', style: { background: '#FEE2E2', color: '#DC2626' } },
};
const STATUS_TOAST = {
  activate: ['Account activated, user can now log in', 'fa-circle-check'],
  suspend: ['Account suspended', 'fa-pause'],
  deactivate: ['Account deactivated', 'fa-ban'],
  terminate: ['System access terminated', 'fa-power-off'],
};

export default function EditUserModal({ data, closeModal, toast }) {
  const rawName = data.name || 'Maria Santos';
  const nameNoTitle = rawName.replace(/^Dr\.\s*/, '');
  const nameParts = nameNoTitle.split(' ');
  const first = nameParts[0] || '';
  const last = nameParts.slice(1).join(' ') || '';
  // profiles.role is admin/staff/ot/speech/parent, role directly encodes discipline
  // for the two therapist options, no separate specialty field needed.
  const roleOptions = Object.keys(ROLE_DB_MAP);
  const status = data.status || 'Active';

  const accessAction = type => {
    if (type === 'terminate') {
      const checkbox = document.getElementById('terminate-confirm');
      if (!checkbox || !checkbox.checked) {
        toast('Tick the confirmation checkbox first', 'fa-triangle-exclamation');
        return;
      }
    }
    const s = STATUS_ACCESS[type];
    if (data.onAccess) data.onAccess(s.label, s.pillClass, s.style);
    closeModal();
    toast(STATUS_TOAST[type][0], STATUS_TOAST[type][1]);
  };

  const saveEditUser = () => {
    const firstVal = document.getElementById('ef-first').value.trim();
    const lastVal = document.getElementById('ef-last').value.trim();
    const emailVal = document.getElementById('ef-email').value.trim();
    const phoneVal = document.getElementById('ef-phone').value.trim();
    const roleVal = document.getElementById('ef-role').value;
    const cb = data.onSave;
    closeModal();
    if (cb) cb({ name: firstVal + (lastVal ? ' ' + lastVal : ''), email: emailVal, phone: phoneVal, ...(ROLE_DB_MAP[roleVal] || { role: 'staff' }) });
    toast('User updated successfully', 'fa-check');
  };

  return (
    <Modal title={<><i className="fa-solid fa-user-pen" style={{ color: '#0EA5E9', marginRight: 8 }} />Edit User{data.id ? ': ' + data.id : ''}</>} onClose={closeModal} width={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 6 }}>
        <div><label className="form-label">First Name</label><input id="ef-first" className="form-input" defaultValue={first} /></div>
        <div><label className="form-label">Last Name</label><input id="ef-last" className="form-input" defaultValue={last} /></div>
        <div><label className="form-label">Email</label><input id="ef-email" className="form-input" type="email" defaultValue={data.email || ''} /></div>
        <div><label className="form-label">Phone</label><input id="ef-phone" className="form-input" defaultValue={data.phone || ''} /></div>
        <div style={{ gridColumn: '1/-1' }}>
          <label className="form-label">Role</label>
          <select id="ef-role" className="form-select" defaultValue={roleOptions.includes(data.role) ? data.role : 'Staff'}>
            {roleOptions.map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <div style={{ borderTop: '1px solid #F1F5F9', margin: '16px 0 14px' }} />
      <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 3, fontFamily: "'Poppins',sans-serif" }}>System Access</div>
      <div style={{ fontSize: 12, color: '#64748B', marginBottom: 14 }}>Control this user's access to the KID Clinic system.</div>

      {status !== 'Active' && (
        <div style={{ border: '1px solid #BBF7D0', borderRadius: 10, padding: '12px 14px', background: '#F0FDF4', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: '#DCFCE7', color: '#16A34A', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="fa-solid fa-check-circle" style={{ fontSize: 13 }} /></div>
            <div><div style={{ fontSize: 13, fontWeight: 600, color: '#14532D' }}>Activate Account</div><div style={{ fontSize: 11.5, color: '#166534', marginTop: 2 }}>Restore full system access. User can log in immediately.</div></div>
          </div>
          <button onClick={() => accessAction('activate')} className="btn-edit" style={{ flexShrink: 0, borderColor: '#22C55E', background: '#DCFCE7', color: '#16A34A', fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8 }}><i className="fa-solid fa-check-circle" style={{ marginRight: 4 }} />Activate</button>
        </div>
      )}

      <div style={{ border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 14px', background: '#FFFBEB', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: '#FEF3C7', color: '#D97706', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="fa-solid fa-pause" style={{ fontSize: 13 }} /></div>
          <div><div style={{ fontSize: 13, fontWeight: 600, color: '#92400E' }}>Suspend Account</div><div style={{ fontSize: 11.5, color: '#78350F', marginTop: 2 }}>Temporarily blocks login. Data is preserved.</div></div>
        </div>
        <button onClick={() => accessAction('suspend')} className="btn-edit" style={{ flexShrink: 0, borderColor: '#F59E0B', background: '#FEF3C7', color: '#B45309', fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8 }}><i className="fa-solid fa-pause" style={{ marginRight: 4 }} />Suspend</button>
      </div>

      <div style={{ border: '1px solid #FDBA74', borderRadius: 10, padding: '12px 14px', background: '#FFF7ED', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: '#FFEDD5', color: '#EA580C', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="fa-solid fa-ban" style={{ fontSize: 13 }} /></div>
          <div><div style={{ fontSize: 13, fontWeight: 600, color: '#7C2D12' }}>Deactivate Account</div><div style={{ fontSize: 11.5, color: '#9A3412', marginTop: 2 }}>Disables all access. Requires admin to reactivate.</div></div>
        </div>
        <button onClick={() => accessAction('deactivate')} className="btn-edit" style={{ flexShrink: 0, borderColor: '#FB923C', background: '#FFEDD5', color: '#C2410C', fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8 }}><i className="fa-solid fa-ban" style={{ marginRight: 4 }} />Deactivate</button>
      </div>

      <div style={{ border: '1px solid #FECACA', borderRadius: 10, padding: '12px 14px', background: '#FFF5F5', marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: '#FEE2E2', color: '#DC2626', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="fa-solid fa-power-off" style={{ fontSize: 13 }} /></div>
            <div><div style={{ fontSize: 13, fontWeight: 600, color: '#991B1B' }}>Terminate Access</div><div style={{ fontSize: 11.5, color: '#7F1D1D', marginTop: 2 }}>Permanently revokes all access. Irreversible.</div></div>
          </div>
          <button onClick={() => accessAction('terminate')} className="btn-danger" style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 8, borderColor: '#EF4444' }}><i className="fa-solid fa-power-off" style={{ marginRight: 4 }} />Terminate</button>
        </div>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 44 }}>
          <input type="checkbox" id="terminate-confirm" style={{ accentColor: '#DC2626', width: 13, height: 13, cursor: 'pointer' }} />
          <label htmlFor="terminate-confirm" style={{ fontSize: 11.5, color: '#991B1B', fontWeight: 500, cursor: 'pointer' }}>I understand this action cannot be undone</label>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={saveEditUser}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 6 }} />Save Changes</button></div>
    </Modal>
  );
}

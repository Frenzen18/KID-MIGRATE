import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api.js';
import { LoadingState, TableEmptyRow } from '../../../components/ui.jsx';

/* == page: users == */

/* Helper: derive display fields from a profile row */
function mapProfile(p) {
  const initials = (p.full_name || '')
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const roleMeta = {
    admin: { label: 'Administrator', pillClass: 'pill pill-blue', bg: 'linear-gradient(135deg,#0EA5E9,#0D9488)', color: '#fff' },
    ot: { label: 'Occupational Therapist', pillClass: 'pill pill-teal', bg: '#CCFBF1', color: '#0F766E' },
    speech: { label: 'Speech-Language Therapist', pillClass: 'pill pill-teal', bg: '#CCFBF1', color: '#0F766E' },
    staff: { label: 'Staff', pillClass: 'pill pill-amber', bg: '#FEF3C7', color: '#D97706' },
    parent: { label: 'Guardian/Caretaker', pillClass: 'pill pill-purple', bg: '#F3E8FF', color: '#9333EA' },
  };
  const rm = roleMeta[p.role] || roleMeta.staff;
  const roleLabel = rm.label;

  const statusLabel = p.active ? 'Active' : 'Suspended';
  const statusPillClass = p.active ? 'pill pill-green status-pill' : 'pill pill-red status-pill';

  /* Use the real user_code from the database */
  const userCode = p.user_code || '–';

  return {
    id: p.id,
    userCode,
    email: p.email || '',
    full_name: p.full_name || '',
    role: p.role || 'staff',
    active: p.active,
    created_at: p.created_at,
    // display helpers
    initials,
    avatarBg: rm.bg,
    avatarColor: rm.color,
    roleLabel,
    rolePillClass: rm.pillClass,
    statusLabel,
    statusPillClass,
    canDelete: true,
  };
}

function rowText(u) {
  return [u.id, u.userCode, u.initials, u.full_name, u.email, u.roleLabel, u.statusLabel]
    .join(' ')
    .toLowerCase();
}

export default function Users({ go, toast, openModal }) {
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());

  // Jumped here from the Dashboard's "Manage in Users" link, prefill the search
  // with that therapist's name so they land straight on the right row. Reading
  // (and clearing) sessionStorage is a side effect, so it belongs in an effect,
  // not a useState initializer, React StrictMode double-invokes initializers
  // in dev, which would silently clear the key before the "real" render read it.
  useEffect(() => {
    const prefill = sessionStorage.getItem('kid_users_prefill_search');
    if (prefill) {
      sessionStorage.removeItem('kid_users_prefill_search');
      setQuery(prefill);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api('/users');
      setUsers(data.map(p => mapProfile(p)));
      setSelected(new Set());
    } catch (err) {
      toast('Failed to load users: ' + err.message, 'fa-triangle-exclamation');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const q = query.toLowerCase();
  const visibleUsers = users
    .filter(u => rowText(u).includes(q))
    .filter(u => !roleFilter || u.roleLabel === roleFilter)
    .filter(u => !statusFilter || u.statusLabel === statusFilter);

  /* ── Bulk selection ── */
  const allVisibleSelected = visibleUsers.length > 0 && visibleUsers.every(u => selected.has(u.id));

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(visibleUsers.map(u => u.id)));
  }

  async function bulkSetActive(active) {
    const ids = [...selected];
    try {
      await Promise.all(ids.map(id => api('/users/' + id, { method: 'PUT', body: { active } })));
      toast(ids.length + ' user' + (ids.length > 1 ? 's' : '') + (active ? ' activated' : ' suspended'), active ? 'fa-user-check' : 'fa-user-slash');
    } catch (err) {
      toast('Error: ' + err.message, 'fa-triangle-exclamation');
    }
    fetchUsers();
  }

  function bulkDelete() {
    const ids = [...selected];
    openModal('delete-user', {
      name: ids.length + ' selected user' + (ids.length > 1 ? 's' : ''),
      id: '',
      onConfirm: async () => {
        try {
          await Promise.all(ids.map(id => api('/users/' + id, { method: 'DELETE' })));
          toast(ids.length + ' user' + (ids.length > 1 ? 's' : '') + ' deleted', 'fa-trash');
        } catch (err) {
          toast('Error: ' + err.message, 'fa-triangle-exclamation');
        }
        fetchUsers();
      },
    });
  }

  const totalUsers = users.length;

  /* ── CRUD handlers ── */
  function handleAddUser() {
    openModal('add-user', {
      onSave: async (formData) => {
        try {
          await api('/users', {
            method: 'POST',
            body: {
              email: formData.email,
              password: formData.password,
              first_name: formData.first_name,
              last_name: formData.last_name,
              full_name: formData.full_name,
              role: formData.role,
              contact: formData.contact,
            },
          });
          toast('User created successfully!', 'fa-user-plus');
          fetchUsers();
          return true;
        } catch (err) {
          toast(err.message, 'fa-triangle-exclamation');
          return false; // keeps the Add User form open with its values
        }
      },
    });
  }

  function handleEditUser(u) {
    openModal('edit-user', {
      id: u.userCode !== '–' ? u.userCode : '',
      name: u.full_name,
      email: u.email,
      role: u.roleLabel,
      phone: '',
      status: u.statusLabel,
      onSave: async (patch) => {
        try {
          const body = {};
          if (patch.name) body.full_name = patch.name;
          if (patch.role) body.role = patch.role;
          await api('/users/' + u.id, { method: 'PUT', body });
          toast('User updated successfully', 'fa-check');
          fetchUsers();
        } catch (err) {
          toast('Error: ' + err.message, 'fa-triangle-exclamation');
        }
      },
      onAccess: async (label) => {
        try {
          const active = label === 'Active';
          await api('/users/' + u.id, { method: 'PUT', body: { active } });
          toast('Access updated, ' + label, 'fa-check');
          fetchUsers();
        } catch (err) {
          toast('Error: ' + err.message, 'fa-triangle-exclamation');
        }
      },
    });
  }

  function handleDeleteUser(u) {
    openModal('delete-user', {
      name: u.full_name,
      id: u.userCode !== '–' ? u.userCode : '',
      onConfirm: async () => {
        try {
          await api('/users/' + u.id, { method: 'DELETE' });
          toast('User deleted', 'fa-trash');
          fetchUsers();
        } catch (err) {
          toast('Error: ' + err.message, 'fa-triangle-exclamation');
        }
      },
    });
  }

  /* Format date for display */
  function formatDate(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div className="spa-page" id="spa-users">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>User Account Management</h1>
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Manage staff accounts, roles, and access permissions across KID Clinic.</p>
          <p style={{ fontSize: 11.5, color: '#94A3B8', margin: '4px 0 0' }}>Create new user profiles &nbsp;·&nbsp; Update existing profiles &nbsp;·&nbsp; Suspend / Deactivate access</p>
        </div>
        <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={handleAddUser}><i className="fa-solid fa-user-plus" style={{ color: '#0EA5E9' }} /> Add User</button>
      </div>

      {/* Filters + Table */}
      <div className="card" style={{ padding: '22px 0 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', flexWrap: 'wrap', gap: 10 }}>
          <div><div className="section-title">All Users</div><div className="section-sub">Showing {visibleUsers.length} of {totalUsers} total users</div></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}><i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8', fontSize: 12 }} /><input type="text" className="filter-input" placeholder="Search users…" id="table-search" value={query} onChange={e => setQuery(e.target.value)} /></div>
            <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5, padding: '0 28px 0 10px' }} id="role-filter" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option value="">All Roles</option><option>Administrator</option><option>Occupational Therapist</option><option>Speech-Language Therapist</option><option>Staff</option><option>Guardian/Caretaker</option></select>
            <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5, padding: '0 28px 0 10px' }} id="status-filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All Status</option><option>Active</option><option>Suspended</option></select>
          </div>
        </div>
        {/* Bulk actions apply to 2+ users, a single user has its own row buttons. */}
        {selected.size > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', background: '#F0F9FF', borderBottom: '1px solid #BAE6FD', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#0284C7' }}><i className="fa-solid fa-check-square" style={{ marginRight: 6 }} />{selected.size} selected</span>
            <button className="btn-edit" onClick={() => bulkSetActive(true)}><i className="fa-solid fa-user-check" style={{ marginRight: 4 }} />Activate</button>
            <button className="btn-edit" onClick={() => bulkSetActive(false)}><i className="fa-solid fa-user-slash" style={{ marginRight: 4 }} />Suspend</button>
            <button className="btn-danger" onClick={bulkDelete}><i className="fa-solid fa-trash" style={{ marginRight: 4 }} />Delete</button>
            <span style={{ fontSize: 12, color: '#64748B', cursor: 'pointer', marginLeft: 'auto', fontWeight: 500 }} onClick={() => setSelected(new Set())}>Clear selection</span>
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <LoadingState label="Loading users…" padding="40px 24px" fontSize={14} color="#64748B" />
          ) : (
          <table className="data-table" id="users-table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 24 }}><input type="checkbox" style={{ accentColor: '#0EA5E9', width: 14, height: 14, cursor: 'pointer' }} checked={allVisibleSelected} onChange={toggleSelectAll} title="Select all" /></th>
                <th style={{ color: '#64748B', fontSize: 11, letterSpacing: '.05em', textAlign: 'center' }}>ID</th>
                <th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th>Status</th>
                <th style={{ textAlign: 'center' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.length === 0 ? (
                <TableEmptyRow colSpan={8} label="No users found." padding="30px 24px" />
              ) : visibleUsers.map(u => (
                <tr key={u.id}>
                  <td style={{ paddingLeft: 24 }}><input type="checkbox" style={{ accentColor: '#0EA5E9', width: 14, height: 14, cursor: 'pointer' }} checked={selected.has(u.id)} onChange={() => toggleSelect(u.id)} /></td>
                  <td style={{ fontSize: 12, color: '#94A3B8', fontWeight: 600, fontFamily: "'Inter',monospace", whiteSpace: 'nowrap', textAlign: 'center' }}>{u.userCode}</td>
                  <td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="act-avatar" style={{ width: 32, height: 32, background: u.avatarBg, color: u.avatarColor, fontSize: 11 }}>{u.initials}</div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{u.full_name}</div></div></div></td>
                  <td style={{ fontSize: 12.5, color: '#475569' }}>{u.email}</td>
                  <td><span className={u.rolePillClass}>{u.roleLabel}</span></td>
                  <td style={{ fontSize: 12.5, color: '#475569' }}>{formatDate(u.created_at)}</td>
                  <td><span className={u.statusPillClass}>{u.statusLabel}</span></td>
                  <td style={{ textAlign: 'center' }}><div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                    <button className="btn-edit" onClick={() => handleEditUser(u)}><i className="fa-solid fa-pen" style={{ marginRight: 3 }} />Edit</button>
                    {u.canDelete && <button className="btn-danger" onClick={() => handleDeleteUser(u)}><i className="fa-solid fa-trash" style={{ marginRight: 3 }} />Delete</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 24px', borderTop: '1px solid #F1F5F9', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#64748B' }}>Showing {visibleUsers.length} of {totalUsers} users</span>
        </div>
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System</span><span style={{ fontSize: 12, color: '#94A3B8', cursor: 'pointer' }}>Support</span></div>
    </div>
  );
}

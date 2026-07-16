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
    contact: p.contact || '',
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

// Compact role label for the table's Role column, side by side the two tables don't have room
// for "Speech-Language Therapist" in full, the role filter/search still use the full roleLabel.
const SHORT_ROLE = { 'Administrator': 'Admin', 'Occupational Therapist': 'OT', 'Speech-Language Therapist': 'Speech', 'Guardian/Caretaker': 'Guardian' };

const cell = { padding: '9px 10px' };
const headCell = { padding: '9px 10px', color: '#64748B', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 600, textAlign: 'left', borderBottom: '1px solid #F1F5F9' };

// Baseline px width per column, shared by both tables so matching columns (ID, Role, ...) are
// exactly the same size in each regardless of column count, "same design" side by side instead
// of one table's columns stretching wider than the other's to fill its card. These sum to less
// than a card's width, table-layout:fixed with width:100% then grows every column proportionally
// to fill the rest, so the leftover space is spread evenly across columns instead of dumped
// entirely into one (which used to leave a big empty gap before Role).
const COL_W = { checkbox: 28, id: 100, name: 150, role: 68, joined: 54, status: 62, actions: 54 };

// Both tables show a fixed number of row-slots so the two cards match in height no matter how
// many users land in each group, one table having fewer rows (e.g. guardians) used to leave its
// card shorter than the other and break the side-by-side layout. Rows beyond this scroll inside
// the card instead of growing it further.
const VISIBLE_ROWS = 5;
const ROW_H = 41; // approx rendered height of a data-table row (padding + font-size below)

const filterSelect = { width: 'auto', height: 34, fontSize: 12.5, padding: '0 28px 0 10px', flexShrink: 0 };

/** One users table, reused for the staff/therapist/admin group and the guardian/caretaker group.
 *  Both instances render the exact same columns, and now each carries its own search/filter row
 *  and bulk-selection bar, so the two cards are identical in design, only the rows they're fed
 *  (and the role filter, staff-only) differ. */
function UsersTable({ title, subtitle, rows, totalCount, selected, allSelected, onToggleAll, onToggleRow, onEdit, onDelete, formatDate, formatDateFull,
  searchValue, onSearchChange, roleOptions, roleFilter, onRoleFilterChange, statusFilter, onStatusFilterChange,
  onBulkActivate, onBulkSuspend, onBulkDelete, onClearSelection, onAddUser }) {
  const colCount = 7;
  const selectedRows = rows.filter(u => selected.has(u.id));
  return (
    <div className="card" style={{ padding: '22px 0 0', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <div>
            <div className="section-title">{title}</div>
            {subtitle && <div className="section-sub">{subtitle}</div>}
          </div>
          <button className="qa-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5, flexShrink: 0 }} onClick={onAddUser}><i className="fa-solid fa-user-plus" style={{ color: '#0EA5E9' }} /> Add User</button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
          <div style={{ position: 'relative', flex: '1 1 140px', minWidth: 120 }}>
            <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8', fontSize: 12 }} />
            <input type="text" className="filter-input" style={{ width: '100%' }} placeholder="Search…" value={searchValue} onChange={e => onSearchChange(e.target.value)} />
          </div>
          {roleOptions && (
            <select className="form-select" style={filterSelect} value={roleFilter} onChange={e => onRoleFilterChange(e.target.value)}>
              <option value="">All Roles</option>
              {roleOptions.map(r => <option key={r}>{r}</option>)}
            </select>
          )}
          <select className="form-select" style={filterSelect} value={statusFilter} onChange={e => onStatusFilterChange(e.target.value)}>
            <option value="">All Status</option><option>Active</option><option>Suspended</option>
          </select>
        </div>
        <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 8 }}>Showing {rows.length} of {totalCount}</div>
        {/* Bulk actions apply to 2+ selected rows in this table, a single row has its own row buttons. */}
        {selectedRows.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px solid #F1F5F9', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#0284C7' }}><i className="fa-solid fa-check-square" style={{ marginRight: 6 }} />{selectedRows.length} selected</span>
            <button className="btn-edit" onClick={() => onBulkActivate(selectedRows.map(u => u.id))}><i className="fa-solid fa-user-check" style={{ marginRight: 4 }} />Activate</button>
            <button className="btn-edit" onClick={() => onBulkSuspend(selectedRows.map(u => u.id))}><i className="fa-solid fa-user-slash" style={{ marginRight: 4 }} />Suspend</button>
            <button className="btn-danger" onClick={() => onBulkDelete(selectedRows.map(u => u.id))}><i className="fa-solid fa-trash" style={{ marginRight: 4 }} />Delete</button>
            <span style={{ fontSize: 12, color: '#64748B', cursor: 'pointer', marginLeft: 'auto', fontWeight: 500 }} onClick={() => onClearSelection(rows)}>Clear selection</span>
          </div>
        )}
      </div>
      <div style={{ overflowX: 'hidden', overflowY: 'auto', flex: 1, minHeight: VISIBLE_ROWS * ROW_H }}>
        <table className="data-table" style={{ tableLayout: 'fixed', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...headCell, paddingLeft: 20, width: COL_W.checkbox }}><input type="checkbox" style={{ accentColor: '#0EA5E9', width: 14, height: 14, cursor: 'pointer' }} checked={allSelected} onChange={onToggleAll} title="Select all" /></th>
              <th style={{ ...headCell, textAlign: 'center', width: COL_W.id }}>ID</th>
              <th style={{ ...headCell, width: COL_W.name }}>Name</th><th style={{ ...headCell, width: COL_W.role }}>Role</th><th style={{ ...headCell, width: COL_W.joined }}>Joined</th><th style={{ ...headCell, width: COL_W.status }}>Status</th>
              <th style={{ ...headCell, textAlign: 'center', width: COL_W.actions }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <TableEmptyRow colSpan={colCount} label="No users found." padding="30px 24px" />
            ) : rows.map(u => (
              <tr key={u.id}>
                <td style={{ ...cell, paddingLeft: 20 }}><input type="checkbox" style={{ accentColor: '#0EA5E9', width: 14, height: 14, cursor: 'pointer' }} checked={selected.has(u.id)} onChange={() => onToggleRow(u.id)} /></td>
                <td style={{ ...cell, fontSize: 11, color: '#94A3B8', fontWeight: 600, fontFamily: "'Inter',monospace", whiteSpace: 'nowrap', textAlign: 'center' }}>{u.userCode}</td>
                <td style={cell}><div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}><div className="act-avatar" style={{ width: 26, height: 26, background: u.avatarBg, color: u.avatarColor, fontSize: 10, flexShrink: 0 }}>{u.initials}</div><div style={{ overflow: 'hidden' }}><div style={{ fontSize: 12.5, fontWeight: 600, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={u.full_name}>{u.full_name}</div><div style={{ fontSize: 11, color: '#94A3B8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={u.email}>{u.email}</div></div></div></td>
                <td style={cell}><span className={u.rolePillClass} style={{ fontSize: 10, padding: '3px 7px' }}>{SHORT_ROLE[u.roleLabel] || u.roleLabel}</span></td>
                <td style={{ ...cell, fontSize: 11.5, color: '#475569', whiteSpace: 'nowrap' }} title={formatDateFull(u.created_at)}>{formatDate(u.created_at)}</td>
                <td style={cell}><span className={u.statusPillClass} style={{ fontSize: 10, padding: '3px 7px' }}>{u.statusLabel}</span></td>
                <td style={{ ...cell, paddingRight: 16, textAlign: 'center' }}><div style={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
                  <button className="btn-edit" style={{ padding: '4px 7px' }} title="Edit" onClick={() => onEdit(u)}><i className="fa-solid fa-pen" /></button>
                  {u.canDelete && <button className="btn-danger" style={{ padding: '4px 7px' }} title="Delete" onClick={() => onDelete(u)}><i className="fa-solid fa-trash" /></button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '14px 24px', borderTop: '1px solid #F1F5F9' }} />
    </div>
  );
}

export default function Users({ go, toast, openModal }) {
  // Each table gets its own search/filter, they're independent lists now, not one list split
  // in two, so a search in one shouldn't touch what's showing in the other.
  const [staffQuery, setStaffQuery] = useState('');
  const [staffRoleFilter, setStaffRoleFilter] = useState('');
  const [staffStatusFilter, setStaffStatusFilter] = useState('');
  const [guardianQuery, setGuardianQuery] = useState('');
  const [guardianStatusFilter, setGuardianStatusFilter] = useState('');
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
      setStaffQuery(prefill);
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

  // Guardians/Caretakers get their own table, separate from staff/therapist/admin accounts.
  const staffUsers = users.filter(u => u.role !== 'parent');
  const guardianUsers = users.filter(u => u.role === 'parent');

  const staffQ = staffQuery.toLowerCase();
  const visibleStaffUsers = staffUsers
    .filter(u => rowText(u).includes(staffQ))
    .filter(u => !staffRoleFilter || u.roleLabel === staffRoleFilter)
    .filter(u => !staffStatusFilter || u.statusLabel === staffStatusFilter);

  const guardianQ = guardianQuery.toLowerCase();
  const visibleGuardianUsers = guardianUsers
    .filter(u => rowText(u).includes(guardianQ))
    .filter(u => !guardianStatusFilter || u.statusLabel === guardianStatusFilter);

  /* ── Bulk selection ── */
  const allStaffSelected = visibleStaffUsers.length > 0 && visibleStaffUsers.every(u => selected.has(u.id));
  const allGuardiansSelected = visibleGuardianUsers.length > 0 && visibleGuardianUsers.every(u => selected.has(u.id));

  function toggleSelectAllIn(rows, allSelected) {
    setSelected(prev => {
      const next = new Set(prev);
      if (allSelected) rows.forEach(u => next.delete(u.id));
      else rows.forEach(u => next.add(u.id));
      return next;
    });
  }

  function clearSelectionIn(rows) {
    setSelected(prev => {
      const next = new Set(prev);
      rows.forEach(u => next.delete(u.id));
      return next;
    });
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function bulkSetActive(ids, active) {
    try {
      await Promise.all(ids.map(id => api('/users/' + id, { method: 'PUT', body: { active } })));
      toast(ids.length + ' user' + (ids.length > 1 ? 's' : '') + (active ? ' activated' : ' suspended'), active ? 'fa-user-check' : 'fa-user-slash');
    } catch (err) {
      toast('Error: ' + err.message, 'fa-triangle-exclamation');
    }
    fetchUsers();
  }

  function bulkDelete(ids) {
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

  /* ── CRUD handlers ── */
  // Each card's own Add User button only offers roles within that card's category, a staff card
  // can't create a Guardian/Caretaker account and vice versa, same boundary as editing (see
  // EditUserModal), roleOptions here scopes which options AddUserModal's Role select shows.
  function handleAddUser(roleOptions) {
    openModal('add-user', {
      roleOptions,
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

  // The Edit User modal closes itself as soon as Save is clicked, before the request even goes
  // out. Re-deriving the row via a fresh fetchUsers() round trip after the PUT would flash the
  // whole page to "Loading users…" (fetchUsers flips that on for every call) and still leave the
  // table showing the old role/status for a beat, that reads as "the change didn't take" even
  // though it saved fine. The PUT already returns the updated row, use that to patch local state
  // directly instead, no second request, no loading flash, no stale window.
  function handleEditUser(u) {
    openModal('edit-user', {
      id: u.userCode !== '–' ? u.userCode : '',
      name: u.full_name,
      email: u.email,
      role: u.roleLabel,
      phone: u.contact,
      status: u.statusLabel,
      onSave: async (patch) => {
        try {
          const body = {};
          if (patch.name) body.full_name = patch.name;
          if (patch.role) body.role = patch.role;
          if ('phone' in patch) body.contact = patch.phone;
          const updated = await api('/users/' + u.id, { method: 'PUT', body });
          setUsers(prev => prev.map(x => x.id === u.id ? mapProfile(updated) : x));
          toast('User updated successfully', 'fa-check');
        } catch (err) {
          toast('Error: ' + err.message, 'fa-triangle-exclamation');
        }
      },
      onAccess: async (label) => {
        try {
          const active = label === 'Active';
          const updated = await api('/users/' + u.id, { method: 'PUT', body: { active } });
          setUsers(prev => prev.map(x => x.id === u.id ? mapProfile(updated) : x));
          toast('Access updated, ' + label, 'fa-check');
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

  /* Format date for display, full (tooltip) and short (table cell, no year, side by side leaves little room) */
  function formatDate(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function formatDateShort(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  }

  return (
    <div className="spa-page" id="spa-users">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>User Account Management</h1>
      </div>

      {loading ? (
        <div className="card"><LoadingState label="Loading users…" padding="40px 24px" fontSize={14} color="#64748B" /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'stretch' }}>
          <UsersTable
            title="Staff, Therapist & Admin Accounts"
            rows={visibleStaffUsers}
            totalCount={staffUsers.length}
            selected={selected}
            allSelected={allStaffSelected}
            onToggleAll={() => toggleSelectAllIn(visibleStaffUsers, allStaffSelected)}
            onToggleRow={toggleSelect}
            onEdit={handleEditUser}
            onDelete={handleDeleteUser}
            formatDate={formatDateShort}
            formatDateFull={formatDate}
            searchValue={staffQuery}
            onSearchChange={setStaffQuery}
            roleOptions={['Administrator', 'Occupational Therapist', 'Speech-Language Therapist', 'Staff']}
            roleFilter={staffRoleFilter}
            onRoleFilterChange={setStaffRoleFilter}
            statusFilter={staffStatusFilter}
            onStatusFilterChange={setStaffStatusFilter}
            onBulkActivate={ids => bulkSetActive(ids, true)}
            onBulkSuspend={ids => bulkSetActive(ids, false)}
            onBulkDelete={bulkDelete}
            onClearSelection={clearSelectionIn}
            onAddUser={() => handleAddUser(['Administrator', 'Staff', 'Occupational Therapist', 'Speech-Language Therapist'])}
          />
          <UsersTable
            title="Guardian / Caretaker Accounts"
            rows={visibleGuardianUsers}
            totalCount={guardianUsers.length}
            selected={selected}
            allSelected={allGuardiansSelected}
            onToggleAll={() => toggleSelectAllIn(visibleGuardianUsers, allGuardiansSelected)}
            onToggleRow={toggleSelect}
            onEdit={handleEditUser}
            onDelete={handleDeleteUser}
            formatDate={formatDateShort}
            formatDateFull={formatDate}
            searchValue={guardianQuery}
            onSearchChange={setGuardianQuery}
            statusFilter={guardianStatusFilter}
            onStatusFilterChange={setGuardianStatusFilter}
            onBulkActivate={ids => bulkSetActive(ids, true)}
            onBulkSuspend={ids => bulkSetActive(ids, false)}
            onBulkDelete={bulkDelete}
            onClearSelection={clearSelectionIn}
            onAddUser={() => handleAddUser(['Guardian/Caretaker'])}
          />
        </div>
      )}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System</span><span style={{ fontSize: 12, color: '#94A3B8', cursor: 'pointer' }}>Support</span></div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { api } from '../../../api.js';

/* == page: audit == */

/** "Jun 27, 8:45 AM" style timestamp, or "-" for null. */
function fmt(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const ACTION_PILL = {
  create: 'pill pill-blue',
  update: 'pill pill-teal',
  approve: 'pill pill-green',
  archive: 'pill pill-amber',
  delete: 'pill pill-red',
  login: 'pill pill-gray'
};

const TABLE_LABEL = {
  profiles: 'User Account',
  clients: 'Client Record',
  reservations: 'Reservation',
  payments: 'Payment',
  cms_posts: 'CMS Post',
  announcements: 'Announcement',
  shifts: 'Therapist Shift',
  notifications: 'Notification Push'
};

const ROLE_LABEL = { admin: 'Administrator', staff: 'Staff', ot: 'Occupational Therapist', speech: 'Speech-Language Therapist', parent: 'Guardian/Caretaker' };

// Which stat boxes make sense for a role, e.g. a therapist or guardian/caretaker
// can never approve or delete a record, so those stay hidden for them instead
// of showing a permanent 0.
const ROLE_VISIBLE_STATS = {
  admin: ['login', 'create', 'update', 'approve', 'archive', 'delete'],
  staff: ['login', 'create', 'update', 'approve', 'archive', 'delete'],
  ot: ['login', 'create', 'update'],
  speech: ['login', 'create', 'update'],
  parent: ['login', 'create', 'update']
};

const STAT_CONFIG = [
  { key: 'login', label: 'Logins', value: s => s.login_count },
  { key: 'create', label: 'Created', value: s => s.action_counts.create },
  { key: 'update', label: 'Updated', value: s => s.action_counts.update },
  { key: 'approve', label: 'Approved', value: s => s.action_counts.approve },
  { key: 'archive', label: 'Archived', value: s => s.action_counts.archive },
  { key: 'delete', label: 'Deleted', value: s => s.action_counts.delete }
];

const PAGE_SIZE = 20;

/** Clickable "Created/Updated/Approved By" name, opens that user's activity summary. */
function UserLink({ person, onClick }) {
  if (!person?.id) return '-';
  return (
    <button type="button" onClick={() => onClick(person.id)} style={{ background: 'none', border: 'none', padding: 0, color: '#0284C7', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
      {person.full_name}
    </button>
  );
}

export default function Audit({ toast }) {
  /* ── Real audit trail (created_by/updated_by/approved_by), fetched from /api/audit ── */
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [tableFilter, setTableFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  /* ── Per-user activity: click a name in the trail, or search by their
     account ID, to scope the table to one user and see their login count +
     action breakdown ── */
  const [users, setUsers] = useState([]);
  const [userFilter, setUserFilter] = useState('');
  const [userSearchText, setUserSearchText] = useState('');
  const [userSummary, setUserSummary] = useState(null);
  const [userSummaryLoading, setUserSummaryLoading] = useState(false);
  useEffect(() => { api('/users').then(data => setUsers(data || [])).catch(() => setUsers([])); }, []);

  /* ── Pagination, the trail can get long fast, only render a page at a time ── */
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(logs.length / PAGE_SIZE));
  const pagedLogs = logs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const fetchLogs = (overrides = {}) => {
    setLogsLoading(true);
    const table = 'table' in overrides ? overrides.table : tableFilter;
    const action = 'action' in overrides ? overrides.action : actionFilter;
    const user = 'user' in overrides ? overrides.user : userFilter;
    const params = new URLSearchParams();
    if (table) params.set('table', table);
    if (action) params.set('action', action);
    if (user) params.set('user', user);
    const qs = params.toString();
    api('/audit' + (qs ? '?' + qs : ''))
      .then(data => { setLogs(data || []); setPage(1); })
      .catch(() => { setLogs([]); toast('Failed to load audit trail', 'fa-triangle-exclamation'); })
      .finally(() => setLogsLoading(false));
  };
  useEffect(() => { fetchLogs(); }, []);

  function selectUser(id) {
    setUserFilter(id);
    const found = id ? users.find(u => u.id === id) : null;
    setUserSearchText(found ? (found.user_code || found.full_name) : '');
    fetchLogs({ user: id });
    if (!id) { setUserSummary(null); return; }
    setUserSummaryLoading(true);
    api('/audit/user/' + id + '/summary')
      .then(setUserSummary)
      .catch(() => { setUserSummary(null); toast('Failed to load user activity', 'fa-triangle-exclamation'); })
      .finally(() => setUserSummaryLoading(false));
  }

  /** Typing/picking in the "Search by User ID" field (native datalist autocomplete). */
  function handleUserSearchChange(val) {
    setUserSearchText(val);
    if (!val) { selectUser(''); return; }
    const match = users.find(u => u.user_code === val || u.id === val);
    if (match) selectUser(match.id);
  }

  function exportCsv() {
    if (!logs.length) { toast('No audit events to export', 'fa-triangle-exclamation'); return; }
    const header = ['Record', 'Action', 'Description', 'Created By', 'Created At', 'Updated By', 'Updated At', 'Approved By', 'Approved At'];
    const rows = logs.map(l => [
      TABLE_LABEL[l.table_name] || l.table_name, l.action, l.description || '',
      l.creator?.full_name || '', l.created_at || '',
      l.updater?.full_name || '', l.updated_at || '',
      l.approver?.full_name || '', l.approved_at || ''
    ]);
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    // Leading BOM, without it Excel guesses Windows-1252 instead of UTF-8 and mangles non-ASCII characters.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Audit trail exported to CSV', 'fa-file-export');
  }

  function exportPdf() {
    if (!logs.length) { toast('No audit events to export', 'fa-triangle-exclamation'); return; }
    window.print();
  }

  return (
    <div className="spa-page" id="spa-audit">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #audit-print, #audit-print * { visibility: visible; }
          #audit-print { position: fixed; top: 0; left: 0; width: 100%; max-height: none !important; overflow: visible !important; margin: 0; padding: 20px; box-shadow: none; border: none; }
          #audit-print .no-print { display: none !important; }
          #audit-print-heading { display: block !important; }
        }
      `}</style>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Security Audit Logs</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={exportCsv}>
            <i className="fa-solid fa-file-export" style={{ color: '#0D9488' }} /> Export CSV
          </button>
          <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={exportPdf}>
            <i className="fa-solid fa-file-pdf" style={{ color: '#EF4444' }} /> Export PDF
          </button>
        </div>
      </div>


      {/* ═══════ 8.1, RECORD AUDIT TRAIL (created_by / updated_by / approved_by) ═══════ */}
      <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }} id="audit-print">
        <div className="no-print" style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="section-title">Record Audit Trail</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <input
                list="audit-user-ids"
                className="form-input"
                style={{ width: 170, height: 34, fontSize: 12.5 }}
                placeholder="Search by User ID…"
                value={userSearchText}
                onChange={e => handleUserSearchChange(e.target.value)}
              />
              <datalist id="audit-user-ids">
                {users.map(u => <option key={u.id} value={u.user_code || u.id}>{u.full_name} ({ROLE_LABEL[u.role] || u.role})</option>)}
              </datalist>
            </div>
            <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={tableFilter} onChange={e => setTableFilter(e.target.value)}>
              <option value="">All Records</option>
              <option value="profiles">User Accounts</option>
              <option value="clients">Client Records</option>
              <option value="reservations">Reservations</option>
              <option value="payments">Payments</option>
              <option value="cms_posts">CMS Posts</option>
              <option value="announcements">Announcements</option>
              <option value="shifts">Therapist Shifts</option>
              <option value="notifications">Notification Pushes</option>
            </select>
            <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={actionFilter} onChange={e => setActionFilter(e.target.value)}>
              <option value="">All Actions</option>
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="approve">Approve</option>
              <option value="archive">Archive</option>
              <option value="delete">Delete</option>
              <option value="login">Login</option>
            </select>
            <button className="pill pill-blue" style={{ cursor: 'pointer', border: 'none', padding: '6px 12px', fontSize: 12 }} onClick={() => fetchLogs()}>
              <i className="fa-solid fa-filter" style={{ marginRight: 4 }} />Apply
            </button>
          </div>
        </div>

        {userFilter && (
          <div className="no-print" style={{ margin: '0 24px 16px', padding: '14px 18px', borderRadius: 10, background: '#F5F3FF', border: '1px solid #DDD6FE', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {userSummaryLoading ? (
              <span style={{ fontSize: 12.5, color: '#6D28D9' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading user activity…</span>
            ) : userSummary ? (
              <>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#4C1D95' }}>{userSummary.profile.full_name}</div>
                  <div style={{ fontSize: 11.5, color: '#6D28D9' }}>{ROLE_LABEL[userSummary.profile.role] || userSummary.profile.role}{userSummary.profile.active === false ? ' · Inactive' : ''}</div>
                </div>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  {STAT_CONFIG.filter(s => (ROLE_VISIBLE_STATS[userSummary.profile.role] || []).includes(s.key)).map(s => (
                    <div key={s.key}><div style={{ fontSize: 17, fontWeight: 700, color: '#0F172A' }}>{s.value(userSummary)}</div><div style={{ fontSize: 10.5, color: '#6D28D9' }}>{s.label}</div></div>
                  ))}
                  <div><div style={{ fontSize: 17, fontWeight: 700, color: '#0F172A' }}>{userSummary.total_actions}</div><div style={{ fontSize: 10.5, color: '#6D28D9' }}>Total</div></div>
                </div>
              </>
            ) : (
              <span style={{ fontSize: 12.5, color: '#6D28D9' }}>Couldn't load activity for this user.</span>
            )}
          </div>
        )}
        <div style={{ display: 'none', padding: '14px 24px 0', fontSize: 12, color: '#94A3B8' }} id="audit-print-heading">
          <strong style={{ color: '#0F172A', fontSize: 14 }}>Security Audit Logs</strong>, generated {fmt(new Date().toISOString())}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" id="audit-table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 24 }}>Record</th>
                <th>Action</th>
                <th>Description</th>
                <th>Created By</th>
                <th>Created At</th>
                <th>Updated By</th>
                <th>Updated At</th>
                <th>Approved By</th>
                <th>Approved At</th>
              </tr>
            </thead>
            <tbody>
              {logsLoading && (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>Loading audit trail…</td></tr>
              )}
              {!logsLoading && logs.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>No audit events yet</td></tr>
              )}
              {!logsLoading && pagedLogs.map(l => (
                <tr key={l.id}>
                  <td style={{ paddingLeft: 24, fontSize: 12, fontWeight: 600, color: '#0284C7' }}>{TABLE_LABEL[l.table_name] || l.table_name}</td>
                  <td><span className={ACTION_PILL[l.action] || 'pill'} style={{ fontSize: 10 }}>{l.action}</span></td>
                  <td style={{ fontSize: 12.5, color: '#64748B', maxWidth: 320 }}>{l.description || '-'}</td>
                  <td style={{ fontSize: 12 }}><UserLink person={l.creator} onClick={selectUser} /></td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(l.created_at)}</td>
                  <td style={{ fontSize: 12 }}><UserLink person={l.updater} onClick={selectUser} /></td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(l.updated_at)}</td>
                  <td style={{ fontSize: 12 }}><UserLink person={l.approver} onClick={selectUser} /></td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(l.approved_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 24px', borderTop: '1px solid #F1F5F9', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>Showing {pagedLogs.length} of {logs.length} event{logs.length === 1 ? '' : 's'}</span>
          </div>
          {totalPages > 1 && (
            <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="btn-secondary" style={{ fontSize: 11.5, padding: '5px 12px' }} disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                <i className="fa-solid fa-chevron-left" style={{ marginRight: 4 }} />Prev
              </button>
              <span style={{ fontSize: 12, color: '#64748B' }}>Page {page} of {totalPages}</span>
              <button className="btn-secondary" style={{ fontSize: 11.5, padding: '5px 12px' }} disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
                Next<i className="fa-solid fa-chevron-right" style={{ marginLeft: 4 }} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Security &amp; System Audit Logging</span></div>
    </div>
  );
}

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
  delete: 'pill pill-red'
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

export default function Audit({ toast }) {
  /* ── Real audit trail (created_by/updated_by/approved_by), fetched from /api/audit ── */
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [tableFilter, setTableFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');

  const fetchLogs = () => {
    setLogsLoading(true);
    const params = new URLSearchParams();
    if (tableFilter) params.set('table', tableFilter);
    if (actionFilter) params.set('action', actionFilter);
    const qs = params.toString();
    api('/audit' + (qs ? '?' + qs : ''))
      .then(data => setLogs(data || []))
      .catch(() => { setLogs([]); toast('Failed to load audit trail', 'fa-triangle-exclamation'); })
      .finally(() => setLogsLoading(false));
  };
  useEffect(() => { fetchLogs(); }, []);

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
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
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
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Automated immutable system logs and background access records.</p>
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


      {/* Immutability notice */}
      <div style={{ padding: '12px 18px', borderRadius: 10, background: '#F0F9FF', border: '1px solid #BFDBFE', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 14 }}>
        <i className="fa-solid fa-shield-halved" style={{ color: '#2563EB', fontSize: 18, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#1E40AF' }}>Immutable Log System</div>
          <div style={{ fontSize: 12.5, color: '#3B82F6', marginTop: 2 }}>All entries in this audit trail are write-once and cannot be modified, deleted, or truncated. System logs are automated and generated without manual intervention. Each row is cryptographically timestamped at creation.</div>
        </div>
        <span className="immutable-badge" style={{ flexShrink: 0 }}><i className="fa-solid fa-lock" style={{ fontSize: 9 }} />IMMUTABLE</span>
      </div>

      {/* ═══════ 8.1, RECORD AUDIT TRAIL (created_by / updated_by / approved_by) ═══════ */}
      <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }} id="audit-print">
        <div className="no-print" style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="section-title">Record Audit Trail</div>
            <div className="section-sub">Live created_by / updated_by / approved_by trail for accounts, clients, reservations and payments</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
              <option value="delete">Delete</option>
            </select>
            <button className="pill pill-blue" style={{ cursor: 'pointer', border: 'none', padding: '6px 12px', fontSize: 12 }} onClick={fetchLogs}>
              <i className="fa-solid fa-filter" style={{ marginRight: 4 }} />Apply
            </button>
          </div>
        </div>
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
              {!logsLoading && logs.map(l => (
                <tr key={l.id}>
                  <td style={{ paddingLeft: 24, fontSize: 12, fontWeight: 600, color: '#0284C7' }}>{TABLE_LABEL[l.table_name] || l.table_name}</td>
                  <td><span className={ACTION_PILL[l.action] || 'pill'} style={{ fontSize: 10 }}>{l.action}</span></td>
                  <td style={{ fontSize: 12.5, color: '#64748B', maxWidth: 320 }}>{l.description || '-'}</td>
                  <td style={{ fontSize: 12 }}>{l.creator?.full_name || '-'}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(l.created_at)}</td>
                  <td style={{ fontSize: 12 }}>{l.updater?.full_name || '-'}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(l.updated_at)}</td>
                  <td style={{ fontSize: 12 }}>{l.approver?.full_name || '-'}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmt(l.approved_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 24px', borderTop: '1px solid #F1F5F9', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>Showing latest {logs.length} event{logs.length === 1 ? '' : 's'}</span>
            <span className="immutable-badge"><i className="fa-solid fa-lock" style={{ fontSize: 9 }} />Server-recorded</span>
          </div>
        </div>
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Security &amp; System Audit Logging</span></div>
    </div>
  );
}

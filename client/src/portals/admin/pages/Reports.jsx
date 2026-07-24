import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import { useAuth } from '../../../auth.jsx';
import GasProgressChart from '../../../components/GasProgressChart.jsx';
import { PieChart, TrendChart } from './Dashboard.jsx';

/* == page: reports == */

/** Mirrors Dashboard.jsx's gasScoreToneHex, the same green/blue/amber/red GAS-score
 *  bands used on the T-score pill elsewhere in this app (Milestones.jsx's gasScoreTone). */
function gasScoreToneHex(score) {
  if (score == null) return '#94A3B8';
  if (score >= 60) return '#16A34A';
  if (score >= 45) return '#2563EB';
  if (score >= 35) return '#B45309';
  return '#DC2626';
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function startOfMonthStr() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); }
function fmtLong(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtGeneratedAt(d) {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const REPORT_TYPES = [
  { key: 'dashboard', label: 'Dashboard Overview' },
  { key: 'transactions', label: 'Transaction Reports' },
  { key: 'milestones', label: 'Client Milestone Progress' },
  { key: 'reservations', label: 'Reservation Summary' },
  { key: 'audit', label: 'Security Audit' }
];

// Same status options as Adjust & Cancel Schedules' filter (Reservations.jsx), so the
// Reservation Summary report's filter matches the live Booking and Appointment page.
const RESERVATION_STATUS_OPTIONS = [
  { value: 'all', label: 'All Status' },
  { value: 'pending', label: 'Pending' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'completed', label: 'Completed' },
  { value: 'no_show', label: 'No-Show' }
];

// Same Record/Action options as the Security Audit Logs page (Audit.jsx).
const AUDIT_TABLE_OPTIONS = [
  { value: '', label: 'All Records' },
  { value: 'profiles', label: 'User Accounts' },
  { value: 'clients', label: 'Client Records' },
  { value: 'reservations', label: 'Reservations' },
  { value: 'payments', label: 'Payments' },
  { value: 'cms_posts', label: 'CMS Posts' },
  { value: 'announcements', label: 'Announcements' },
  { value: 'shifts', label: 'Therapist Shifts' },
  { value: 'notifications', label: 'Notification Pushes' }
];
const AUDIT_ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'create', label: 'Create' },
  { value: 'update', label: 'Update' },
  { value: 'approve', label: 'Approve' },
  { value: 'archive', label: 'Archive' },
  { value: 'delete', label: 'Delete' },
  { value: 'login', label: 'Login' }
];

// Same Status/Method options as the live Payments page (Payments.jsx), "Method" here is
// really the payment channel (Online/Offline/Unpaid), same grouping Payments.jsx uses.
const TXN_STATUS_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'paid', label: 'Paid' },
  { value: 'pending', label: 'Pending' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'refunded', label: 'Refunded' }
];
const TXN_CHANNEL_OPTIONS = [
  { value: '', label: 'All Methods' },
  { value: 'Online', label: 'Online' },
  { value: 'Offline', label: 'Offline' },
  { value: 'Unpaid', label: 'Unpaid' }
];

const DASHBOARD_SECTIONS = [
  { key: 'milestones', label: 'Milestone Trends' },
  { key: 'employees', label: 'Employee Statistics' },
  { key: 'demographics', label: 'Demographics' }
];

/** The audit trail has its own endpoint/shape, normalize it to match every other report. */
function normalizeAudit(logs, from, to) {
  return {
    title: 'Security Audit Report',
    range: { from, to },
    summary: [
      { label: 'Total Events', value: String(logs.length) },
      { label: 'Approvals', value: String(logs.filter(l => l.approved_by).length) },
      { label: 'Creates', value: String(logs.filter(l => l.action === 'create').length) },
      { label: 'Updates / Deletes', value: String(logs.filter(l => l.action === 'update' || l.action === 'delete').length) }
    ],
    columns: [
      { key: 'table_name', label: 'Table' }, { key: 'action', label: 'Action' }, { key: 'description', label: 'Description' },
      { key: 'created_by', label: 'Created By' }, { key: 'created_at', label: 'Created At' },
      { key: 'updated_by', label: 'Updated By' }, { key: 'updated_at', label: 'Updated At' },
      { key: 'approved_by', label: 'Approved By' }, { key: 'approved_at', label: 'Approved At' }
    ],
    rows: logs.map(l => ({
      table_name: l.table_name, action: l.action, description: l.description || '-',
      created_by: l.creator?.full_name || '-', created_at: fmtDateTime(l.created_at),
      updated_by: l.updater?.full_name || '-', updated_at: fmtDateTime(l.updated_at),
      approved_by: l.approver?.full_name || '-', approved_at: fmtDateTime(l.approved_at)
    }))
  };
}

/** Renders the "Dashboard Overview" report with the same charts as the live Admin Dashboard. */
function DashboardReportView({ report }) {
  const { gasTrend, employees, demo } = report;
  const empRows = employees?.rows || [];
  const genderTotal = demo ? demo.gender.Male + demo.gender.Female + demo.gender.Unspecified : 0;
  const ageTotal = demo ? Object.values(demo.ageBrackets).reduce((s, v) => s + v, 0) : 0;

  return (
    <div style={{ padding: '4px 24px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {gasTrend && (
        <div style={{ display: 'grid', gridTemplateColumns: (gasTrend.otCount > 0 && gasTrend.speechCount > 0) ? '1fr 1fr' : '1fr', gap: 16 }}>
          {gasTrend.otCount > 0 && (
            <div className="card" style={{ padding: 20 }}>
              <div className="section-title" style={{ marginBottom: 4 }}>GAS T-Score: Occupational Therapy</div>
              <div className="section-sub" style={{ marginBottom: 14 }}>{gasTrend.otCount} entries</div>
              <TrendChart labels={gasTrend.months} series={[{ values: gasTrend.ot, color: '#0EA5E9', toneColors: gasTrend.ot.map(gasScoreToneHex) }]} height={150} min={20} max={80} refLine={50} refLabel="Expected (50)" />
            </div>
          )}
          {gasTrend.speechCount > 0 && (
            <div className="card" style={{ padding: 20 }}>
              <div className="section-title" style={{ marginBottom: 4 }}>GAS T-Score: Speech-Language Therapy</div>
              <div className="section-sub" style={{ marginBottom: 14 }}>{gasTrend.speechCount} entries</div>
              <TrendChart labels={gasTrend.months} series={[{ values: gasTrend.speech, color: '#F59E0B', toneColors: gasTrend.speech.map(gasScoreToneHex) }]} height={150} min={20} max={80} refLine={50} refLabel="Expected (50)" />
            </div>
          )}
          {gasTrend.otCount === 0 && gasTrend.speechCount === 0 && (
            <div className="card" style={{ padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No GAS entries in this date range</div>
          )}
        </div>
      )}

      {employees && (
        <div className="card" style={{ padding: 20 }}>
          <div className="section-title" style={{ marginBottom: 4 }}>Team Composition</div>
          <div className="section-sub" style={{ marginBottom: 16 }}>OT only · Speech only · handles both</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
            <PieChart size={140} centerValue={employees.total} centerLabel="Therapists" segments={[
              { value: employees.specialtyCounts.OT, color: '#0EA5E9' },
              { value: employees.specialtyCounts.Speech, color: '#0D9488' },
              { value: employees.specialtyCounts.Both, color: '#F59E0B' },
              { value: employees.specialtyCounts.Unassigned, color: '#CBD5E1' }
            ]} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#0EA5E9' }}>●</span> OT Only, {employees.specialtyCounts.OT}</div>
              <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#0D9488' }}>●</span> Speech Only, {employees.specialtyCounts.Speech}</div>
              <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#F59E0B' }}>●</span> Both, {employees.specialtyCounts.Both}</div>
              {employees.specialtyCounts.Unassigned > 0 && <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#CBD5E1' }}>●</span> No Sessions Yet, {employees.specialtyCounts.Unassigned}</div>}
            </div>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 18 }}>
            <table className="data-table">
              <thead><tr><th style={{ paddingLeft: 0 }}>Therapist</th><th>Specialty</th><th>Total Sessions</th><th>Clients</th></tr></thead>
              <tbody>
                {empRows.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 16, fontSize: 12.5, color: '#94A3B8' }}>No therapist accounts yet</td></tr>}
                {empRows.map(r => (
                  <tr key={r.name}><td style={{ paddingLeft: 0, fontWeight: 600 }}>{r.name}</td><td>{r.specialty}</td><td style={{ fontWeight: 700 }}>{r.totalSessions}</td><td>{r.clients}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {demo && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card" style={{ padding: 20 }}>
            <div className="section-title" style={{ marginBottom: 16 }}>Gender Distribution</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
              <PieChart size={140} centerValue={genderTotal} centerLabel="Total" segments={[
                { value: demo.gender.Male, color: '#0EA5E9' },
                { value: demo.gender.Female, color: '#EC4899' },
                { value: demo.gender.Unspecified, color: '#CBD5E1' }
              ]} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#0EA5E9' }}>●</span> Male, {demo.gender.Male}</div>
                <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#EC4899' }}>●</span> Female, {demo.gender.Female}</div>
                {demo.gender.Unspecified > 0 && <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#CBD5E1' }}>●</span> Unspecified, {demo.gender.Unspecified}</div>}
              </div>
            </div>
          </div>
          <div className="card" style={{ padding: 20 }}>
            <div className="section-title" style={{ marginBottom: 16 }}>Age Distribution</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
              <PieChart size={140} centerValue={ageTotal} centerLabel="Total" segments={[
                { value: demo.ageBrackets['3-4'], color: '#0EA5E9' },
                { value: demo.ageBrackets['5-6'], color: '#10B981' },
                { value: demo.ageBrackets['7-8'], color: '#818CF8' },
                { value: demo.ageBrackets['9+'], color: '#F59E0B' }
              ]} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#0EA5E9' }}>●</span> Age 3-4, {demo.ageBrackets['3-4']}</div>
                <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#10B981' }}>●</span> Age 5-6, {demo.ageBrackets['5-6']}</div>
                <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#818CF8' }}>●</span> Age 7-8, {demo.ageBrackets['7-8']}</div>
                <div style={{ fontSize: 12.5, color: '#334155' }}><span style={{ color: '#F59E0B' }}>●</span> Age 9+, {demo.ageBrackets['9+']}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Reports({ toast, role = 'admin' }) {
  const { user } = useAuth();
  // Client Milestone Progress and the Security Audit report are clinical /
  // security data, admin only. Staff gets the other four report types.
  const reportTypes = role === 'admin' ? REPORT_TYPES : REPORT_TYPES.filter(r => r.key !== 'audit' && r.key !== 'milestones');

  // Clinic letterhead (logo, name, address), same source as the printable
  // invoice in Payments.jsx, so a printed report reads as the same document family.
  const [brand, setBrand] = useState(null);
  useEffect(() => { fetch('/api/settings/branding/public').then(r => r.json()).then(setBrand).catch(() => {}); }, []);

  const [type, setType] = useState('dashboard');
  const [from, setFrom] = useState(startOfMonthStr());
  const [to, setTo] = useState(todayStr());
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  // Stamped once when a report is generated, not on every render, so a
  // printed copy always shows exactly when it was produced.
  const [generatedAt, setGeneratedAt] = useState(null);
  // How many rows of a tabular report to show/print, 'all' (the default) keeps
  // today's behavior; a smaller cap is for a quick on-screen look without
  // needing to print/scroll through everything.
  const [rowLimit, setRowLimit] = useState('all');

  // Client Milestone Progress is per-client (GAS trends aren't clinic-wide), only
  // fetch the client list when it's actually needed.
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState('');
  useEffect(() => {
    if (type !== 'milestones' || clients.length) return;
    api('/clients').then(setClients).catch(() => setClients([]));
  }, [type, clients.length]);

  // Report-specific filters, each only relevant (and shown) for its own report type.
  const [auditTable, setAuditTable] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [reservationStatus, setReservationStatus] = useState('all');
  const [dashboardSections, setDashboardSections] = useState(() => new Set(DASHBOARD_SECTIONS.map(s => s.key)));
  const [txnStatus, setTxnStatus] = useState('');
  const [txnChannel, setTxnChannel] = useState('');

  function toggleDashboardSection(key) {
    setDashboardSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function generate(reportType, rangeFrom, rangeTo) {
    const t = reportType || type;
    const f = rangeFrom || from;
    const tt = rangeTo || to;
    if (role !== 'admin' && (t === 'audit' || t === 'milestones')) {
      toast('Only an administrator can generate this report', 'fa-triangle-exclamation');
      return;
    }
    if (f > todayStr() || tt > todayStr()) {
      toast('Date range cannot be in the future', 'fa-triangle-exclamation');
      return;
    }
    setType(t); setFrom(f); setTo(tt);
    if (t === 'milestones' && !clientId) {
      toast('Select a client to generate this report', 'fa-triangle-exclamation');
      return;
    }
    if (t === 'dashboard' && dashboardSections.size === 0) {
      toast('Pick at least one section (Milestone Trends, Employee Statistics, or Demographics)', 'fa-triangle-exclamation');
      return;
    }
    setLoading(true);
    try {
      let data;
      if (t === 'audit') {
        const qs = new URLSearchParams({ from: f, to: tt });
        if (auditTable) qs.set('table', auditTable);
        if (auditAction) qs.set('action', auditAction);
        data = normalizeAudit(await api(`/audit?${qs}`), f, tt);
      } else if (t === 'milestones') {
        data = await api(`/reports/milestones?from=${f}&to=${tt}&client_id=${clientId}`);
      } else if (t === 'reservations') {
        data = await api(`/reports/reservations?from=${f}&to=${tt}&status=${reservationStatus}`);
      } else if (t === 'dashboard') {
        const sections = dashboardSections.size === DASHBOARD_SECTIONS.length ? 'all' : [...dashboardSections].join(',');
        data = await api(`/reports/dashboard?from=${f}&to=${tt}&sections=${sections}`);
      } else if (t === 'transactions') {
        const qs = new URLSearchParams({ from: f, to: tt });
        if (txnStatus) qs.set('status', txnStatus);
        if (txnChannel) qs.set('channel', txnChannel);
        data = await api(`/reports/transactions?${qs}`);
      } else {
        data = await api(`/reports/${t}?from=${f}&to=${tt}`);
      }
      setReport(data);
      setGeneratedAt(new Date());
    } catch (e) {
      toast(e.message || 'Failed to generate report', 'fa-triangle-exclamation');
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    if (!report) return;
    const header = report.columns.map(c => c.label);
    const rows = report.rows.map(r => report.columns.map(c => r[c.key] ?? ''));
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    // Leading BOM, without it Excel guesses Windows-1252 instead of UTF-8 and mangles non-ASCII characters (e.g. ₱).
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.title.replace(/\s+/g, '-')}_${report.range.from}_to_${report.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Report exported to CSV', 'fa-file-csv');
  }
  function printReport() { window.print(); }

  return (
    <div className="spa-page" id="spa-reports">
      <style>{`
        @media print {
          @page { margin: 14mm 12mm; }
          /* The old approach (visibility:hidden on everything + position:fixed on the
             target) only ever printed one page, position:fixed clips to a single page
             in every major print engine. Hiding the sidebar/nav/form with display:none
             (which frees their layout space entirely) and letting the report card flow
             normally in the document is what lets it paginate across as many physical
             pages as the row count actually needs. */
          #sidebar, #topnav, .no-print { display: none !important; }
          #main { margin-left: 0 !important; }
          #content { padding: 0 !important; }
          #report-print-outer { overflow: visible !important; box-shadow: none !important; border: none !important; border-radius: 0 !important; margin: 0 !important; }
          #report-print table { page-break-inside: auto; }
          #report-print tr { page-break-inside: avoid; }
          #report-print thead { display: table-header-group; }
        }
      `}</style>

      <div className="no-print" style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Report Generation &amp; Exporting</h1>
      </div>

      <div className="no-print" style={{ display: 'grid', gridTemplateColumns: '1fr', maxWidth: 460, gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: '22px 20px' }}>
          <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-wand-magic-sparkles" style={{ color: '#0EA5E9', marginRight: 6 }} />Report Generator</div>
          <div style={{ marginBottom: 14 }}>
            <label className="form-label">Report Type</label>
            <select className="form-select" value={type} onChange={e => setType(e.target.value)}>
              {reportTypes.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          {type === 'milestones' && (
            <div style={{ marginBottom: 14 }}>
              <label className="form-label">Client *</label>
              <select className="form-select" value={clientId} onChange={e => setClientId(e.target.value)}>
                <option value="">- Select client -</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.full_name}, {c.client_code}</option>)}
              </select>
            </div>
          )}
          {type === 'audit' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label className="form-label">Record</label>
                <select className="form-select" value={auditTable} onChange={e => setAuditTable(e.target.value)}>
                  {AUDIT_TABLE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Action</label>
                <select className="form-select" value={auditAction} onChange={e => setAuditAction(e.target.value)}>
                  {AUDIT_ACTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
          )}
          {type === 'reservations' && (
            <div style={{ marginBottom: 14 }}>
              <label className="form-label">Status</label>
              <select className="form-select" value={reservationStatus} onChange={e => setReservationStatus(e.target.value)}>
                {RESERVATION_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}
          {type === 'dashboard' && (
            <div style={{ marginBottom: 14 }}>
              <label className="form-label">Sections</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {DASHBOARD_SECTIONS.map(s => (
                  <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', cursor: 'pointer' }}>
                    <input type="checkbox" checked={dashboardSections.has(s.key)} onChange={() => toggleDashboardSection(s.key)} />
                    {s.label}
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 5 }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Check all three (or leave them all checked) to include the full overview.</div>
            </div>
          )}
          {type === 'transactions' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label className="form-label">Status</label>
                <select className="form-select" value={txnStatus} onChange={e => setTxnStatus(e.target.value)}>
                  {TXN_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Method</label>
                <select className="form-select" value={txnChannel} onChange={e => setTxnChannel(e.target.value)}>
                  {TXN_CHANNEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
            <div><label className="form-label">Date From</label><input type="date" className="form-input" max={todayStr()} value={from} onChange={e => setFrom(e.target.value)} /></div>
            <div><label className="form-label">Date To</label><input type="date" className="form-input" max={todayStr()} value={to} onChange={e => setTo(e.target.value)} /></div>
          </div>
          <button className="btn-primary" style={{ width: '100%' }} disabled={loading} onClick={() => generate()}>
            {loading ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Generating…</> : <><i className="fa-solid fa-file-chart-column" style={{ marginRight: 6 }} />Generate Report</>}
          </button>
        </div>
      </div>

      {!report && (
        <div className="card" style={{ padding: '40px 20px', marginBottom: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
          <i className="fa-solid fa-file-chart-column" style={{ fontSize: 32, marginBottom: 12, color: '#CBD5E1' }} />
          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#64748B', marginBottom: 4 }}>No report generated yet</div>
          <div style={{ fontSize: 12.5, color: '#94A3B8', maxWidth: 320 }}>Pick a report type and date range, then click "Generate Report" to see it here, ready to export as CSV or print to PDF.</div>
        </div>
      )}

      {report && (
        <div id="report-print-outer" className="card" style={{ padding: 0, marginBottom: 24, overflow: 'hidden' }}>
          <div id="report-print">
            {/* Letterhead, matches the printable invoice in Payments.jsx: logo + clinic
                identity top-left, a thick brand-colored bar underneath as the divider. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14, padding: '24px 24px 18px', borderBottom: '3px solid #1F4E9E' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {brand?.logo_url
                  ? <img src={brand.logo_url} alt={brand.clinic_name} style={{ width: 46, height: 46, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
                  : <div style={{ width: 46, height: 46, borderRadius: 10, background: 'linear-gradient(135deg,#1F4E9E,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <i className="fa-solid fa-child-reaching" style={{ color: '#fff', fontSize: 19 }} />
                    </div>}
                <div>
                  <div style={{ fontFamily: "'Poppins',sans-serif", fontSize: 18, fontWeight: 700, color: '#0F172A', lineHeight: 1.2 }}>{brand?.clinic_name || 'Bloomsdale Therapy Center'}</div>
                  <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>Pediatric Speech &amp; Occupational Therapy</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>{brand?.address || 'Imus, Cavite, Philippines'}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: "'Poppins',sans-serif", fontSize: 19, fontWeight: 700, color: '#1F4E9E', letterSpacing: '.03em' }}>{report.title}</div>
                <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>{fmtLong(report.range.from)} – {fmtLong(report.range.to)}</div>
                {generatedAt && <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 2 }}>Generated {fmtGeneratedAt(generatedAt)}</div>}
              </div>
            </div>

            {/* Export actions, screen-only */}
            <div className="no-print" style={{ padding: '12px 24px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {!report.gasEntries && !report.gasTrend && !report.employees && !report.demo && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, color: '#64748B' }}>Show</span>
                  <input
                    type="number" min="1" step="1"
                    className="form-input"
                    style={{ width: 66, height: 34, fontSize: 12, padding: '0 8px' }}
                    placeholder="rows"
                    disabled={rowLimit === 'all'}
                    value={rowLimit === 'all' ? '' : rowLimit}
                    onChange={e => setRowLimit(e.target.value)}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#64748B', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={rowLimit === 'all'} onChange={e => setRowLimit(e.target.checked ? 'all' : '25')} />
                    All rows
                  </label>
                </div>
              )}
              {!report.gasEntries && !report.gasTrend && !report.employees && !report.demo && <button className="qa-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: 12 }} onClick={exportCsv}><i className="fa-solid fa-file-csv" style={{ color: '#0D9488' }} /> Export CSV</button>}
              <button className="qa-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: 12 }} onClick={printReport}><i className="fa-solid fa-print" style={{ color: '#0284C7' }} /> Print / Save as PDF</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, padding: '18px 24px' }}>
              {report.summary.map(s => (
                <div key={s.label} style={{ padding: '12px 14px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{s.value}</div>
                </div>
              ))}
            </div>

            {report.gasEntries ? (
              <div style={{ padding: '4px 24px 24px' }}>
                <GasProgressChart entries={report.gasEntries} />
              </div>
            ) : (report.gasTrend || report.employees || report.demo) ? (
              <DashboardReportView report={report} />
            ) : (() => {
              // A custom row count can transiently be empty/invalid mid-typing (deleting
              // the digits before entering a new value), gracefully show everything until
              // the field holds a real positive number rather than showing zero rows.
              const customN = parseInt(rowLimit, 10);
              const shownRows = (rowLimit === 'all' || !Number.isFinite(customN) || customN <= 0)
                ? report.rows
                : report.rows.slice(0, customN);
              return (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead><tr>{report.columns.map((c, i) => <th key={c.key} style={i === 0 ? { paddingLeft: 24 } : undefined}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {shownRows.length === 0 && <tr><td colSpan={report.columns.length} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>No data for this date range</td></tr>}
                      {shownRows.map((row, i) => (
                        <tr key={i}>
                          {report.columns.map((c, ci) => <td key={c.key} style={ci === 0 ? { paddingLeft: 24, fontSize: 12.5 } : { fontSize: 12.5 }}>{row[c.key]}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: '14px 24px', fontSize: 12, color: '#64748B' }}>
                  {shownRows.length === report.rows.length
                    ? <>Showing {report.rows.length} row{report.rows.length === 1 ? '' : 's'}</>
                    : <>Showing {shownRows.length} of {report.rows.length} rows</>}
                </div>
              </>
              );
            })()}

            {/* Printed footer, who/when generated it plus a confidentiality line, matches
                the print-only footer note style used on the printable invoice. */}
            <div style={{ marginTop: 8, padding: '14px 24px 20px', borderTop: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 10.5, color: '#94A3B8' }}>Generated by {user?.name || 'System'}{generatedAt ? ' · ' + fmtGeneratedAt(generatedAt) : ''}</div>
              <div style={{ fontSize: 10.5, color: '#94A3B8' }}>{brand?.clinic_name || 'Bloomsdale Therapy Center'} · Confidential, for internal use only</div>
            </div>
          </div>
        </div>
      )}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System</span></div>
    </div>
  );
}

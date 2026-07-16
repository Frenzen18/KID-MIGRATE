import { useEffect, useState } from 'react';
import { api } from '../../../api.js';
import GasProgressChart from '../../../components/GasProgressChart.jsx';
import { PieChart, TrendChart } from './Dashboard.jsx';

/* == page: reports == */

function todayStr() { return new Date().toISOString().slice(0, 10); }
function startOfMonthStr() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); }

function fmtDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const REPORT_TYPES = [
  { key: 'summary', label: 'Monthly Summary' },
  { key: 'dashboard', label: 'Dashboard Overview' },
  { key: 'revenue', label: 'Revenue Report' },
  { key: 'milestones', label: 'Client Milestone Progress' },
  { key: 'therapists', label: 'Therapist Performance' },
  { key: 'reservations', label: 'Reservation Summary' },
  { key: 'audit', label: 'Security Audit' }
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
              <TrendChart labels={gasTrend.months} series={[{ values: gasTrend.ot, color: '#0EA5E9' }]} height={150} />
            </div>
          )}
          {gasTrend.speechCount > 0 && (
            <div className="card" style={{ padding: 20 }}>
              <div className="section-title" style={{ marginBottom: 4 }}>GAS T-Score: Speech-Language Therapy</div>
              <div className="section-sub" style={{ marginBottom: 14 }}>{gasTrend.speechCount} entries</div>
              <TrendChart labels={gasTrend.months} series={[{ values: gasTrend.speech, color: '#F59E0B' }]} height={150} />
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
  // Client Milestone Progress and the Security Audit report are clinical /
  // security data, admin only. Staff gets the other four report types.
  const reportTypes = role === 'admin' ? REPORT_TYPES : REPORT_TYPES.filter(r => r.key !== 'audit' && r.key !== 'milestones');

  const [type, setType] = useState('summary');
  const [from, setFrom] = useState(startOfMonthStr());
  const [to, setTo] = useState(todayStr());
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);

  // Client Milestone Progress is per-client (GAS trends aren't clinic-wide), only
  // fetch the client list when it's actually needed.
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState('');
  useEffect(() => {
    if (type !== 'milestones' || clients.length) return;
    api('/clients').then(setClients).catch(() => setClients([]));
  }, [type, clients.length]);

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
    setLoading(true);
    try {
      const data = t === 'audit'
        ? normalizeAudit(await api(`/audit?from=${f}&to=${tt}`), f, tt)
        : await api(`/reports/${t}?from=${f}&to=${tt}` + (t === 'milestones' ? `&client_id=${clientId}` : ''));
      setReport(data);
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
          body * { visibility: hidden; }
          #report-print, #report-print * { visibility: visible; }
          #report-print { position: fixed; top: 0; left: 0; width: 100%; padding: 24px; }
          #report-print .no-print { display: none !important; }
        }
      `}</style>

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Report Generation &amp; Exporting</h1>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', maxWidth: 460, gap: 16, marginBottom: 24 }}>
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
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div id="report-print">
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div className="section-title">{report.title}</div>
                <div className="section-sub">{report.range.from} to {report.range.to}</div>
              </div>
              <div className="no-print" style={{ display: 'flex', gap: 8 }}>
                {!report.gasEntries && !report.gasTrend && !report.employees && !report.demo && <button className="qa-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: 12 }} onClick={exportCsv}><i className="fa-solid fa-file-csv" style={{ color: '#0D9488' }} /> Export CSV</button>}
                <button className="qa-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: 12 }} onClick={printReport}><i className="fa-solid fa-print" style={{ color: '#0284C7' }} /> Print / Save as PDF</button>
              </div>
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
            ) : type === 'summary' ? null : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead><tr>{report.columns.map((c, i) => <th key={c.key} style={i === 0 ? { paddingLeft: 24 } : undefined}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {report.rows.length === 0 && <tr><td colSpan={report.columns.length} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>No data for this date range</td></tr>}
                      {report.rows.map((row, i) => (
                        <tr key={i}>
                          {report.columns.map((c, ci) => <td key={c.key} style={ci === 0 ? { paddingLeft: 24, fontSize: 12.5 } : { fontSize: 12.5 }}>{row[c.key]}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ padding: '14px 24px', fontSize: 12, color: '#64748B' }}>Showing {report.rows.length} row{report.rows.length === 1 ? '' : 's'}</div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System</span></div>
    </div>
  );
}

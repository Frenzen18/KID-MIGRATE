import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../../components/ui.jsx';
import ProgressChart from '../../../components/ProgressChart.jsx';
import GasProgressChart from '../../../components/GasProgressChart.jsx';

/* == page: clients == */

/* Color palette for avatars (cycle based on index) */
const AVATAR_COLORS = [
  { bg: '#DBEAFE', color: '#2563EB' },
  { bg: '#CCFBF1', color: '#0F766E' },
  { bg: '#FEF3C7', color: '#D97706' },
  { bg: '#EDE9FE', color: '#818CF8' },
  { bg: '#F3E8FF', color: '#9333EA' },
  { bg: '#E0F2FE', color: '#0284C7' },
  { bg: '#DCFCE7', color: '#16A34A' },
  { bg: '#FFE4E6', color: '#E11D48' },
];

const STATUS_PILLS = {
  active: { label: 'Active', pill: 'pill pill-green' },
  'on hold': { label: 'On Hold', pill: 'pill pill-amber' },
  discharged: { label: 'Discharged', pill: 'pill pill-red' },
  new: { label: 'New', pill: 'pill pill-blue' },
};

function calcAge(dob) {
  if (!dob) return '–';
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  return age + ' yrs';
}

function formatDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

function mapClient(c, idx) {
  const initials = (c.full_name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const av = AVATAR_COLORS[idx % AVATAR_COLORS.length];
  const ageLabel = calcAge(c.dob);
  const statusKey = (c.status || 'active').toLowerCase();
  const st = STATUS_PILLS[statusKey] || STATUS_PILLS.active;
  const therapyType = c.therapy_type || 'OT';
  const thxPill = therapyType === 'Speech' ? 'pill pill-teal' : 'pill pill-blue';

  return {
    ...c,
    // display helpers
    initials,
    bg: av.bg,
    color: av.color,
    name: c.full_name,
    ageLabel,
    meta: 'Age ' + ageLabel.replace(' yrs', '') + ' · ' + (c.gender || '–'),
    dob_formatted: formatDate(c.dob),
    guardian: c.guardian_name || '–',
    contact: c.guardian_contact || '–',
    enrolled: formatDate(c.created_at),
    therapy: therapyType,
    thxPill,
    thxType: therapyType,
    thxName: c.assigned_therapist_name || '–',
    status: st.label,
    statusPill: st.pill,
    dx: c.diagnosis || '–',
  };
}

function clientRowText(c) {
  return [c.name, c.client_code, c.ageLabel, c.guardian, c.thxName, c.thxType, c.status]
    .join(' ')
    .toLowerCase();
}

/* ── Availability matrix (3.2.2), real working days from shifts.work_days ── */
const DOT_COLORS = { available: '#22C55E', off: '#E2E8F0' };
// Mon..Sun. Sunday defaults to closed, mirrors server/routes/shifts.js.
const ALL_WORK_DAYS = [true, true, true, true, true, true, false];

/* ── Shift schedules (3.2.1), real data from /api/shifts ── */
export function hourLabel(h) {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return hr + ':00 ' + (h >= 12 ? 'PM' : 'AM');
}

/** Current hour in PH time (UTC+8), used to show On Shift / Off Duty. */
function currentHourPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
}

/** Today's date string in PH time (UTC+8), used to check today's working day. */
function todayPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
/** "YYYY-MM-DD" → work_days index (Mon=0 … Sat=5, Sun=6). Mirrors server/routes/shifts.js. */
function workDayIndexPH(dateStr) {
  return (new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7;
}
/** True if this shift covers today (PH time). */
function worksToday(shift) {
  const idx = workDayIndexPH(todayPH());
  const wd = Array.isArray(shift.work_days) && shift.work_days.length === 7 ? shift.work_days : ALL_WORK_DAYS;
  return wd[idx] !== false;
}

function mapShift(s, idx) {
  const initials = (s.name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const av = AVATAR_COLORS[idx % AVATAR_COLORS.length];
  const onShift = currentHourPH() >= s.start_hour && currentHourPH() < s.end_hour;
  return {
    ...s,
    initials,
    bg: av.bg,
    color: av.color,
    start: hourLabel(s.start_hour),
    end: hourLabel(s.end_hour),
    status: onShift ? 'On Shift' : 'Off Duty',
    statusPill: onShift ? 'pill pill-green' : 'pill pill-gray',
  };
}

/* ── Financial transactions (3.3), real data from /api/payments ── */
const PAY_CLASSES = { paid: 'pill-green', pending: 'pill-amber', overdue: 'pill-red', refunded: 'pill-gray' };
const PAY_LABELS = { paid: 'Paid', pending: 'Pending', overdue: 'Overdue', refunded: 'Refunded' };
const PAY_STATES = ['paid', 'pending', 'overdue'];
const THERAPY_PILL = { OT: 'pill pill-blue', Speech: 'pill pill-teal', Both: 'pill pill-blue' };
const METHOD_META = {
  GCash: { pill: 'pill pill-teal', icon: 'fa-mobile-screen-button', style: null },
  Maya: { pill: 'pill pill-teal', icon: 'fa-mobile-screen-button', style: null },
  'Credit Card': { pill: 'pill pill-blue', icon: 'fa-credit-card', style: null },
  Card: { pill: 'pill pill-blue', icon: 'fa-credit-card', style: null },
  Cash: { pill: 'pill pill-amber', icon: 'fa-money-bill', style: null },
  Bank: { pill: 'pill', icon: 'fa-building-columns', style: { background: '#F1F5F9', color: '#64748B', fontSize: 10 } },
  Online: { pill: 'pill', icon: 'fa-globe', style: { background: '#F1F5F9', color: '#64748B', fontSize: 10 } },
};
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Maps a raw /api/payments row (with its joined clients.*) to the shape the financial table/cards render. */
function mapPayment(p) {
  const client = p.clients || {};
  const method = METHOD_META[p.method] || { pill: 'pill', icon: 'fa-circle-dollar-to-slot', style: { background: '#F1F5F9', color: '#64748B', fontSize: 10 } };
  const when = p.paid_at || p.created_at;
  const d = when ? new Date(when) : null;
  const status = (p.status || 'pending').toLowerCase();
  return {
    id: p.id,
    client: client.full_name || '-',
    guardian: client.guardian_name || '-',
    inv: p.invoice_no || ('PMT-' + String(p.id).slice(0, 8).toUpperCase()),
    date: d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '-',
    dateObj: d,
    therapy: client.therapy_type || '-',
    therapyPill: THERAPY_PILL[client.therapy_type] || 'pill',
    amount: '₱' + Number(p.amount || 0).toLocaleString(),
    amountNum: Number(p.amount || 0),
    method: p.method || '-',
    methodPill: method.pill,
    methodIcon: method.icon,
    methodStyle: method.style,
    status: PAY_LABELS[status] || p.status,
    statusKey: status,
    month: d ? MONTH_ABBR[d.getMonth()] : '',
    sealed: p.sealed === true,
    recordAction: status === 'overdue' ? 'followup' : 'seal',
  };
}

export default function Clients({ go, toast, openModal, role = 'admin', scopeToTherapist = false, therapistName = '' }) {
  const [section, setSection] = useState('clients');

  /* client directory, fetched from API */
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clientQuery, setClientQuery] = useState('');
  const [therapyFilter, setTherapyFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [profileVisible, setProfileVisible] = useState(false);
  const [profile, setProfile] = useState(null);
  const [historyName, setHistoryName] = useState('');
  const [progress, setProgress] = useState(null);
  const [progressLoading, setProgressLoading] = useState(false);
  const [gasEntries, setGasEntries] = useState([]);
  const [gasLoading, setGasLoading] = useState(false);
  const [apptCount, setApptCount] = useState(0);
  // Development & Functional Information, the admin-configurable field list
  // used to render/edit this section of the Client Clinical Record.
  const [devFields, setDevFields] = useState([]);
  useEffect(() => { api('/dev-functional-fields').then(setDevFields).catch(() => setDevFields([])); }, []);

  const fetchClients = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api('/clients');
      let rows = data;
      // A therapist sees children they've actually had a real (non-cancelled) session
      // with, derived from reservation history, plus any child an admin/staff has
      // explicitly assigned to them via Edit Client Profile, even before a first session.
      if (scopeToTherapist) {
        const res = await api('/reservations?therapist_name=' + encodeURIComponent(therapistName));
        const activeAppts = (res || []).filter(r => !['cancelled', 'declined'].includes(r.status));
        setApptCount(activeAppts.length);
        const myIds = new Set(activeAppts.map(r => r.client_id));
        for (const c of data) if (c.assigned_therapist_name === therapistName) myIds.add(c.id);
        rows = data.filter(c => myIds.has(c.id));
      }
      setClients(rows.map((c, i) => mapClient(c, i)));
    } catch (err) {
      toast('Failed to load clients: ' + err.message, 'fa-triangle-exclamation');
    } finally {
      setLoading(false);
    }
  }, [toast, scopeToTherapist, therapistName]);

  useEffect(() => { fetchClients(); }, [fetchClients]);

  /* availability matrix, unsaved day toggles, keyed by therapist_id */
  const [dayEdits, setDayEdits] = useState({});
  const [matrixSaving, setMatrixSaving] = useState(false);

  /* employee shifts, fetched from API */
  const [shifts, setShifts] = useState([]);
  const fetchShifts = useCallback(async () => {
    try {
      const data = await api('/shifts');
      setShifts(data.map((s, i) => mapShift(s, i)));
      setDayEdits({});
    } catch (err) {
      toast('Failed to load shifts: ' + err.message, 'fa-triangle-exclamation');
    }
  }, [toast]);
  useEffect(() => { if (!scopeToTherapist) fetchShifts(); }, [fetchShifts, scopeToTherapist]);

  /* financial rows, fetched from /api/payments */
  const [finQuery, setFinQuery] = useState('');
  const [finStatus, setFinStatus] = useState('');
  const [finMonth, setFinMonth] = useState('');
  const [fin, setFin] = useState([]);
  const [finLoading, setFinLoading] = useState(true);

  const fetchPayments = useCallback(async () => {
    try {
      setFinLoading(true);
      const data = await api('/payments');
      setFin((data || []).map(mapPayment));
    } catch (err) {
      toast('Failed to load financial transactions: ' + err.message, 'fa-triangle-exclamation');
    } finally {
      setFinLoading(false);
    }
  }, [toast]);
  useEffect(() => { if (!scopeToTherapist) fetchPayments(); }, [fetchPayments, scopeToTherapist]);

  const cq = clientQuery.toLowerCase();
  const visibleClients = clients.filter(c => {
    const matchSearch = !cq || clientRowText(c).includes(cq);
    const matchTherapy = !therapyFilter || c.therapy === therapyFilter;
    return matchSearch && matchTherapy;
  });

  /* ── Employee Scheduling (3.2) stat cards, derived from real /api/shifts data ── */
  const activeTherapistsCount = shifts.length;
  const shiftsTodayCount = shifts.filter(worksToday).length;
  const offTodayCount = activeTherapistsCount - shiftsTodayCount;
  // Real conflict: two+ therapists on shift today with fully overlapping hours
  // and no other differentiator, flagged so admins can review, not fabricated.
  const scheduleConflicts = (() => {
    const todays = shifts.filter(worksToday);
    let conflicts = 0;
    for (let i = 0; i < todays.length; i++) {
      for (let j = i + 1; j < todays.length; j++) {
        const a = todays[i], b = todays[j];
        const overlap = a.start_hour < b.end_hour && b.start_hour < a.end_hour;
        if (overlap && a.start_hour === b.start_hour && a.end_hour === b.end_hour) conflicts++;
      }
    }
    return conflicts;
  })();

  function updateClient(id, patch) {
    // Called after modal saves via API, just refresh
    fetchClients();
  }

  function removeClient(id) {
    setClients(prev => {
      const next = prev.filter(c => c.id !== id);
      if (next.length === 0 || selectedId === id) {
        setSelectedId(null);
        setProfileVisible(false);
      }
      return next;
    });
  }

  async function saveShift(therapistId, patch) {
    try {
      const r = await api('/shifts/' + therapistId, { method: 'PUT', body: patch });
      if (r.affected > 0) {
        toast(`Shift updated, ${r.affected} booking${r.affected > 1 ? 's' : ''} flagged for rescheduling, parents notified`, 'fa-calendar-xmark');
      } else {
        toast('Shift updated for ' + r.therapist, 'fa-calendar-check');
      }
      fetchShifts();
      return true;
    } catch (err) {
      toast(err.message, 'fa-triangle-exclamation');
      return false;
    }
  }

  /** Downloads the currently-loaded shift schedule as a CSV file (client-side, all the data is already in `shifts`). */
  function exportShiftSchedule() {
    if (!shifts.length) { toast('No shift data to export', 'fa-triangle-exclamation'); return; }
    const dayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const header = ['Therapist', 'Shift Start', 'Shift End', 'Status', 'Work Days'];
    const rows = shifts.map(s => {
      const wd = Array.isArray(s.work_days) && s.work_days.length === 7 ? s.work_days : ALL_WORK_DAYS;
      const days = wd.map((on, i) => on !== false ? dayShort[i] : null).filter(Boolean).join(' ');
      return [s.name, s.start, s.end, s.status, days];
    });
    const csv = [header, ...rows]
      .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shift-schedule-${todayPH()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Shift schedule exported', 'fa-download');
  }

  function selectClient(c) {
    setSelectedId(c.id);
    setProfileVisible(true);
    setProfile({
      id: c.id,
      initials: c.initials, bg: c.bg, color: c.color, name: c.name,
      meta: (c.client_code || c.id) + ' · ' + c.meta,
      clientCode: c.client_code,
      dob: c.dob_formatted, guardian: c.guardian, contact: c.contact, enrolled: c.enrolled, dx: c.dx,
      allergies: c.allergies || 'None recorded', medications: c.daily_medication || 'None recorded',
      thxName: c.thxName, thxInitials: (c.thxName || '–').split(' ').map(w => w[0]).join('').slice(0, 2), thxType: c.thxType,
      status: c.status, statusPill: c.statusPill, therapy: c.therapy,
      // Development & Functional Information, keyed by dev_functional_fields.id
      dev_functional_data: c.dev_functional_data || {},
    });
    setHistoryName(c.name);

    // Development Trend
    setProgress(null);
    setProgressLoading(true);
    api('/analytics/progress/' + c.id)
      .then(setProgress)
      .catch(() => setProgress(null))
      .finally(() => setProgressLoading(false));

    // GAS Longitudinal Progress
    setGasEntries([]);
    setGasLoading(true);
    api('/gas/entries?client_id=' + c.id)
      .then(setGasEntries)
      .catch(() => setGasEntries([]))
      .finally(() => setGasLoading(false));
  }

  function closeClientModal() {
    setProfileVisible(false);
  }

  /* Effective working days for a therapist = unsaved edit, else saved value. */
  const daysFor = s => dayEdits[s.therapist_id] || s.work_days || ALL_WORK_DAYS;

  function toggleDay(s, dayIdx) {
    const next = daysFor(s).slice();
    next[dayIdx] = !next[dayIdx];
    setDayEdits(prev => ({ ...prev, [s.therapist_id]: next }));
  }

  async function saveMatrix() {
    const changed = shifts.filter(s => {
      const edit = dayEdits[s.therapist_id];
      return edit && edit.join() !== (s.work_days || ALL_WORK_DAYS).join();
    });
    if (!changed.length) {
      toast('No availability changes to save', 'fa-circle-info');
      return;
    }
    setMatrixSaving(true);
    let saved = 0, flagged = 0;
    try {
      for (const s of changed) {
        const r = await api('/shifts/' + s.therapist_id, { method: 'PUT', body: { work_days: dayEdits[s.therapist_id] } });
        saved++;
        flagged += r.affected || 0;
      }
      toast(
        `Availability saved, ${saved} therapist${saved > 1 ? 's' : ''} updated` +
        (flagged > 0 ? ` · ${flagged} booking${flagged > 1 ? 's' : ''} flagged, parents notified` : ''),
        flagged > 0 ? 'fa-calendar-xmark' : 'fa-floppy-disk'
      );
      setDayEdits({});
      fetchShifts();
    } catch (err) {
      toast(err.message, 'fa-triangle-exclamation');
    } finally {
      setMatrixSaving(false);
    }
  }

  async function cyclePayment(id) {
    const row = fin.find(r => r.id === id);
    if (!row) return;
    if (row.sealed) {
      toast('This transaction is sealed and cannot be changed', 'fa-lock');
      return;
    }
    const next = PAY_STATES[(PAY_STATES.indexOf(row.statusKey) + 1) % PAY_STATES.length];
    try {
      await api('/payments/' + id, { method: 'PUT', body: { status: next } });
      toast('Status updated to ' + PAY_LABELS[next], 'fa-circle-check');
      fetchPayments();
    } catch (err) {
      toast('Error: ' + err.message, 'fa-triangle-exclamation');
    }
  }

  async function sealTransaction(id, name, inv) {
    const row = fin.find(r => r.id === id);
    if (!row || row.statusKey !== 'paid') {
      toast('Cannot seal, status must be Paid first', 'fa-triangle-exclamation');
      return;
    }
    try {
      await api('/payments/' + id, { method: 'PUT', body: { sealed: true } });
      toast(inv + ' sealed for ' + name, 'fa-lock');
      fetchPayments();
    } catch (err) {
      toast('Error: ' + err.message, 'fa-triangle-exclamation');
    }
  }

  async function sealAllVerified() {
    const targets = fin.filter(r => r.statusKey === 'paid' && !r.sealed);
    if (targets.length === 0) {
      toast('No unsealed Paid transactions found', 'fa-circle-info');
      return;
    }
    try {
      await Promise.all(targets.map(r => api('/payments/' + r.id, { method: 'PUT', body: { sealed: true } })));
      toast(targets.length + ' transaction' + (targets.length > 1 ? 's' : '') + ' sealed successfully', 'fa-lock');
      fetchPayments();
    } catch (err) {
      toast('Error: ' + err.message, 'fa-triangle-exclamation');
    }
  }

  const visibleFin = fin.filter(r => {
    const matchSearch = !finQuery || r.client.toLowerCase().includes(finQuery.toLowerCase()) || r.inv.toLowerCase().includes(finQuery.toLowerCase());
    const matchStatus = !finStatus || r.status === finStatus;
    const matchMonth = !finMonth || r.month === finMonth;
    return matchSearch && matchStatus && matchMonth;
  });

  /* ── 3.3 Billing summary, derived from real /api/payments data for the current calendar month ── */
  const now = new Date();
  const thisMonthFin = fin.filter(r => r.dateObj && r.dateObj.getMonth() === now.getMonth() && r.dateObj.getFullYear() === now.getFullYear());
  const monthName = now.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
  const totalBilled = thisMonthFin.reduce((s, r) => s + r.amountNum, 0);
  const collected = thisMonthFin.filter(r => r.statusKey === 'paid').reduce((s, r) => s + r.amountNum, 0);
  const outstanding = thisMonthFin.filter(r => r.statusKey === 'pending').reduce((s, r) => s + r.amountNum, 0);
  const overdueTotal = thisMonthFin.filter(r => r.statusKey === 'overdue').reduce((s, r) => s + r.amountNum, 0);
  const sealedCount = fin.filter(r => r.sealed).length;
  const awaitingSealCount = fin.filter(r => r.statusKey === 'paid' && !r.sealed).length;
  const outstandingCount = fin.filter(r => r.statusKey === 'pending' || r.statusKey === 'overdue').length;
  const recentlySealed = fin.filter(r => r.sealed).slice(0, 3);

  /* ── Client Progress (7.1.d), bucket the selected client's real attendance rows by month ── */
  const attendanceByMonth = (() => {
    const rows = progress?.attendance || [];
    if (!rows.length) return [];
    const buckets = {};
    for (const r of rows) {
      const d = new Date(r.session_date + 'T00:00:00');
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      if (!buckets[key]) buckets[key] = { label, a: 0, m: 0 };
      if (r.attended) buckets[key].a++; else buckets[key].m++;
    }
    return Object.keys(buckets).sort().map(k => buckets[k]);
  })();

  return (
    <div className="spa-page" id="spa-clients">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #client-record-print, #client-record-print * { visibility: visible; }
          #client-record-print { position: fixed; top: 0; left: 0; width: 100%; max-height: none !important; overflow: visible !important; margin: 0; padding: 20px; box-shadow: none; border: none; }
          #client-record-print .no-print { display: none !important; }
        }
      `}</style>
      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Administrative Information Management</h1>
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Manage client profiles, employee scheduling logs, and financial transaction records.</p>
        </div>
        {!scopeToTherapist && (
          <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={() => openModal('add-client', {
            onSave: async (formData) => {
              try {
                await api('/clients', { method: 'POST', body: formData });
                toast('New client profile created', 'fa-child-reaching');
                fetchClients();
              } catch (err) {
                toast('Error: ' + err.message, 'fa-triangle-exclamation');
              }
            }
          })}>
            <i className="fa-solid fa-plus" style={{ color: '#0EA5E9' }} /> Register New Client
          </button>
        )}
      </div>

      {/* Section Tabs: 3.1 / 3.2 / 3.3 */}
      <div className="tab-nav">
        <button className={'section-tab' + (section === 'clients' ? ' active' : '')} onClick={() => setSection('clients')}><i className="fa-solid fa-child" style={{ marginRight: 6 }} />Client Records &amp; Profiles</button>
        {!scopeToTherapist && <button className={'section-tab' + (section === 'scheduling' ? ' active' : '')} onClick={() => setSection('scheduling')}><i className="fa-solid fa-calendar-alt" style={{ marginRight: 6 }} />Employee Scheduling Logs</button>}
        {!scopeToTherapist && <button className={'section-tab' + (section === 'financial' ? ' active' : '')} onClick={() => setSection('financial')}><i className="fa-solid fa-peso-sign" style={{ marginRight: 6 }} />Financial Transactions</button>}
      </div>

      {/* ═══════════════ SECTION 3.1, CLIENT RECORDS ═══════════════ */}
      <div id="section-clients" style={{ display: section === 'clients' ? '' : 'none' }}>
        {/* Stat cards */}
        {scopeToTherapist && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16, marginBottom: 24 }}>
            <div className="card stat-card" style={{ borderTop: '3px solid #818CF8' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Total Clients</div><div className="stat-value">{clients.length}</div><div className="stat-change up">Your caseload</div></div><div className="stat-icon" style={{ background: '#EDE9FE', color: '#818CF8' }}><i className="fa-solid fa-child-reaching" /></div></div></div>
            <div className="card stat-card" style={{ borderTop: '3px solid #0EA5E9' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Appointments</div><div className="stat-value">{apptCount}</div><div className="stat-change up">Your session history</div></div><div className="stat-icon" style={{ background: '#E0F2FE', color: '#0EA5E9' }}><i className="fa-solid fa-calendar-check" /></div></div></div>
          </div>
        )}

        <div className="card dir-card">
          <div className="dir-head">
            <div><div className="section-title">Client Directory</div><div className="section-sub">View centralized client clinical records</div></div>
            <div className="dir-tools">
              <div className="dir-search"><i className="fa-solid fa-magnifying-glass" /><input id="client-dir-search" type="text" className="filter-input" placeholder="Search name or ID…" style={{ paddingLeft: 30, height: 34, fontSize: 12.5, width: 170 }} value={clientQuery} onChange={e => setClientQuery(e.target.value)} /></div>
              <select id="therapy-filter" className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={therapyFilter} onChange={e => setTherapyFilter(e.target.value)}>
                <option value="">All Therapy Types</option>
                <option value="OT">Occupational Therapy</option>
                <option value="Speech">Speech Therapy</option>
                <option value="Both">Combined</option>
              </select>
            </div>
          </div>
            <div style={{ overflowX: 'auto' }}>
              {loading ? (
                <div style={{ padding: '40px 24px', textAlign: 'center', color: '#64748B', fontSize: 14 }}>
                  <i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading clients…
                </div>
              ) : (
              <div className="cdir" id="clients-table">
                <div className="cdir-row cdir-head">
                  <div>Client</div>
                  <div>Age</div>
                  <div>Guardian</div>
                  <div>Therapist</div>
                  <div>Status</div>
                  <div style={{ textAlign: 'center' }}>Actions</div>
                </div>
                {visibleClients.map(c => (
                  <div key={c.id} className="cdir-row cdir-item" data-therapy={c.therapy} onClick={() => selectClient(c)} style={{ cursor: 'pointer', background: selectedId === c.id ? '#F0F9FF' : '' }}>
                    <div className="cd-client">
                      <div className="act-avatar" style={{ width: 32, height: 32, background: c.bg, color: c.color, fontSize: 11, flexShrink: 0 }}>{c.initials}</div>
                      <div style={{ minWidth: 0 }}><div className="cd-name">{c.name}</div><div className="cd-id">{c.client_code}</div></div>
                    </div>
                    <div className="cd-cell">{c.ageLabel}</div>
                    <div className="cd-cell"><div className="cd-name" style={{ fontWeight: 500 }}>{c.guardian}</div><div className="cd-sub">{c.contact}</div></div>
                    <div className="cd-cell"><span className="cd-name" style={{ fontWeight: 500 }}>{c.thxName !== '–' ? c.thxName + ' ' : ''}</span><span className={c.thxPill} style={{ fontSize: 10 }}>{c.thxType}</span></div>
                    <div className="cd-cell"><span className={c.statusPill}>{c.status}</span></div>
                    <div className="cd-actions" onClick={e => e.stopPropagation()}>
                      {!scopeToTherapist && (
                        <button className="btn-edit" onClick={() => { openModal('edit-client', { name: c.name, guardian: c.guardian, status: c.status, thxName: c.thxName, therapy_type: c.therapy, therapists: shifts, onSave: async (patch) => {
                          try {
                            const body = {};
                            if (patch.name) body.full_name = patch.name;
                            if (patch.guardian) body.guardian_name = patch.guardian;
                            if (patch.status) body.status = patch.status.toLowerCase();
                            if (patch.therapy_type) body.therapy_type = patch.therapy_type;
                            if (patch.thxName) body.assigned_therapist_name = patch.thxName;
                            await api('/clients/' + c.id, { method: 'PUT', body });
                            toast('Client profile updated: ' + (patch.name || c.name), 'fa-check');
                            fetchClients();
                          } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); }
                        } }); }} title="Edit"><i className="fa-solid fa-pen" /></button>
                      )}
                      {role === 'admin' && (
                        <button className="btn-danger" onClick={() => { openModal('delete-client', { name: c.name, onConfirm: async () => {
                          try {
                            await api('/clients/' + c.id, { method: 'DELETE' });
                            toast('Client profile deleted', 'fa-trash');
                            fetchClients();
                          } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); }
                        } }); }} title="Delete"><i className="fa-solid fa-trash" /></button>
                      )}
                    </div>
                  </div>
                ))}
                {visibleClients.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '32px 24px', color: '#94A3B8', fontSize: 12.5 }}>
                    {scopeToTherapist && !clientQuery && !therapyFilter ? 'No clients with session history assigned to you yet.' : 'No clients match your search or filter.'}
                  </div>
                )}
              </div>
              )}
            </div>
          <div className="dir-foot">
            <span style={{ fontSize: 12, color: '#64748B' }}>Showing {visibleClients.length} of {clients.length} clients</span>
            <div className="pagination"><button className="page-btn active">1</button><button className="page-btn">2</button><button className="page-btn">Next →</button></div>
          </div>
        </div>
      </div>

      {/* ═══════ CLIENT RECORD MODAL ═══════ */}
      {profileVisible && profile && (
        <Modal title="Client Clinical Record" onClose={closeClientModal} width={940}>
          <div id="client-record-print" style={{ maxHeight: '78vh', overflowY: 'auto', paddingRight: 4 }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22, paddingBottom: 18, borderBottom: '1px solid #F1F5F9' }}>
              <div style={{ width: 60, height: 60, borderRadius: 14, background: `linear-gradient(135deg,${profile.bg},${profile.color})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color: '#fff', fontFamily: "'Poppins',sans-serif", flexShrink: 0 }}>{profile.initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', fontFamily: "'Poppins',sans-serif" }}>{profile.name}</div>
                <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>{profile.clientCode} · {profile.meta?.split(' · ')[1]}</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}><span className={profile.statusPill}>{profile.status}</span><span className={profile.therapy === 'Speech' ? 'pill pill-teal' : 'pill pill-blue'}>{{ OT: 'Occupational Therapy', Speech: 'Speech Therapy', Both: 'Combined' }[profile.therapy] || 'Occupational Therapy'}</span></div>
              </div>
              <div className="no-print" style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {scopeToTherapist && <button className="btn-primary" onClick={() => openModal('log-progress-note', {
                  childName: profile.name,
                  onSave: async (data) => {
                    if (!selectedId) return;
                    try {
                      await Promise.all([
                        api('/clients/' + selectedId + '/notes', { method: 'POST', body: {
                          domain: data.domain, score: data.score, session_date: data.session_date,
                          remark: data.remark || undefined, next_plan: data.next_plan || undefined,
                          tags: data.tags
                        } }),
                        api('/clients/' + selectedId + '/attendance', { method: 'POST', body: {
                          session_date: data.session_date, attended: data.attended
                        } })
                      ]);
                      toast('Progress note logged', 'fa-check');
                      setProgressLoading(true);
                      api('/analytics/progress/' + selectedId).then(setProgress).catch(() => {}).finally(() => setProgressLoading(false));
                    } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); }
                  }
                })}><i className="fa-solid fa-notes-medical" style={{ marginRight: 4 }} />Log Progress Note</button>}
                <button className="btn-secondary" onClick={() => window.print()}><i className="fa-solid fa-print" style={{ marginRight: 4 }} />Print Record</button>
                {!scopeToTherapist && <button className="btn-edit" onClick={() => { const c = clients.find(cl => cl.id === selectedId); openModal('edit-client', c ? { name: c.name, guardian: c.guardian, status: c.status, thxName: c.thxName, therapy_type: c.therapy, therapists: shifts, onSave: async (patch) => { try { const body = {}; if (patch.name) body.full_name = patch.name; if (patch.guardian) body.guardian_name = patch.guardian; if (patch.status) body.status = patch.status.toLowerCase(); if (patch.therapy_type) body.therapy_type = patch.therapy_type; if (patch.thxName) body.assigned_therapist_name = patch.thxName; await api('/clients/' + c.id, { method: 'PUT', body }); toast('Client profile updated', 'fa-check'); fetchClients(); closeClientModal(); } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); } } } : { name: profile.name }); }}><i className="fa-solid fa-pen" style={{ marginRight: 4 }} />Edit</button>}
                {role === 'admin' && <button className="btn-danger" onClick={() => openModal('delete-client', { name: profile.name, onConfirm: async () => { if (!selectedId) return; try { await api('/clients/' + selectedId, { method: 'DELETE' }); toast('Client profile deleted', 'fa-trash'); closeClientModal(); fetchClients(); } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); } } })}><i className="fa-solid fa-trash" style={{ marginRight: 4 }} />Delete</button>}
              </div>
            </div>
            {/* Two-column info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <div style={{ padding: '16px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><i className="fa-solid fa-id-card" style={{ color: '#818CF8' }} />Personal Information</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Date of Birth</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.dob}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Enrolled Since</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.enrolled}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Guardian</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.guardian}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Contact</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.contact}</div></div>
                </div>
              </div>
              <div style={{ padding: '16px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><i className="fa-solid fa-notes-medical" style={{ color: '#0EA5E9' }} />Medical Information</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Primary Diagnosis</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.dx}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Allergies</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.allergies}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Medications</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.medications}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Emergency Contact</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.guardian}</div></div>
                </div>
              </div>
            </div>
            {/* Assigned Therapist */}
            <div style={{ padding: '14px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: '#DBEAFE', color: '#2563EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{profile.thxInitials}</div>
              <div style={{ flex: 1 }}><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px' }}>Assigned Therapist</div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>{profile.thxName}</div><div style={{ fontSize: 12, color: '#64748B' }}>{profile.thxType === 'Speech' ? 'Speech-Language Pathologist' : 'Occupational Therapist'}</div></div>
              <div style={{ display: 'flex', gap: 6 }}><span className="pill pill-blue" style={{ fontSize: 10 }}>{profile.thxType} Sessions</span><span className="pill pill-teal" style={{ fontSize: 10 }}>2x / week</span></div>
            </div>
            {/* Development & Functional Information */}
            <div style={{ padding: '16px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC', marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', display: 'flex', alignItems: 'center', gap: 6 }}><i className="fa-solid fa-child-reaching" style={{ color: '#4F46E5' }} />Development &amp; Functional Information</div>
                <div className="no-print" style={{ display: 'flex', gap: 6 }}>
                  {role === 'admin' && !scopeToTherapist && (
                    <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => openModal('manage-dev-functional-fields', {
                      onChanged: () => api('/dev-functional-fields').then(setDevFields).catch(() => {})
                    })}><i className="fa-solid fa-sliders" style={{ marginRight: 4 }} />Manage Fields</button>
                  )}
                  <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => openModal('edit-developmental-info', {
                    clientId: selectedId, values: profile, fields: devFields,
                    onSave: async (patch) => {
                      try {
                        await api('/clients/' + selectedId, { method: 'PUT', body: patch });
                        toast('Development & Functional Information updated', 'fa-check');
                        setProfile(p => ({ ...p, ...patch }));
                        fetchClients();
                      } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); }
                    }
                  })}><i className="fa-solid fa-pen" style={{ marginRight: 4 }} />Edit</button>
                </div>
              </div>
              {devFields.length === 0 ? (
                <div style={{ fontSize: 12.5, color: '#94A3B8' }}>No fields configured yet.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {devFields.map(f => (
                    <div key={f.id}>
                      <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>{f.label}</div>
                      <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{(profile.dev_functional_data || {})[f.id] || 'Not recorded'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Client Progress */}
            <div style={{ padding: '16px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC', marginBottom: 20 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><i className="fa-solid fa-chart-area" style={{ color: '#10B981' }} />Client Progress</div>
              {progressLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading…</div>
              ) : progress && Object.keys(progress.domains || {}).length > 0 ? (
                <>
                  <ProgressChart domains={progress.domains} />
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #F1F5F9' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#334155' }}>Attendance</div>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}><i className="fa-solid fa-circle-check" style={{ color: '#10B981', marginRight: 3 }} />Attended <b>{progress.attended}</b></span>
                        <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}><i className="fa-solid fa-circle-xmark" style={{ color: '#EF4444', marginRight: 3 }} />Missed <b>{progress.missed}</b></span>
                        <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}><i className="fa-solid fa-percent" style={{ color: '#0EA5E9', marginRight: 3 }} />Rate <b>{progress.attended + progress.missed > 0 ? Math.round(progress.attended / (progress.attended + progress.missed) * 100) : 0}%</b></span>
                      </div>
                    </div>
                    {attendanceByMonth.map(({ label, a, m }) => { const total = a + m; return (<div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}><span style={{ width: 52, fontSize: 10.5, color: '#64748B', fontWeight: 600 }}>{label}</span><div style={{ flex: 1, height: 7, background: (m ? '#FEE2E2' : '#F1F5F9'), borderRadius: 4, overflow: 'hidden' }}><div style={{ width: Math.round(a / total * 100) + '%', height: '100%', background: '#10B981', borderRadius: '4px 0 0 4px' }} /></div><span style={{ fontSize: 10.5, color: '#475569', fontWeight: 600, width: 48, textAlign: 'right' }}>{a}/{total}</span></div>); })}
                  </div>
                </>
              ) : (
                <div style={{ padding: 20, textAlign: 'center', color: '#94A3B8', fontSize: 12.5 }}>No session notes recorded yet.</div>
              )}
            </div>
            {/* GAS Progress */}
            <div style={{ padding: '16px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}><i className="fa-solid fa-chart-line" style={{ color: '#4F46E5' }} />GAS Longitudinal Progress</div>
              {gasLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading…</div>
              ) : (
                <GasProgressChart entries={gasEntries} />
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* ═══════════════ SECTION 3.2, EMPLOYEE SCHEDULING LOGS ═══════════════ */}
      <div id="section-scheduling" style={{ display: section === 'scheduling' ? '' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16, marginBottom: 24 }}>
          <div className="card stat-card" style={{ borderTop: '3px solid #0EA5E9' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Active Therapists</div><div className="stat-value">{activeTherapistsCount}</div><div className="stat-change up">On shift today</div></div><div className="stat-icon" style={{ background: '#E0F2FE', color: '#0EA5E9' }}><i className="fa-solid fa-stethoscope" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #10B981' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Shifts Today</div><div className="stat-value">{shiftsTodayCount}</div><div className="stat-change up">{shiftsTodayCount === activeTherapistsCount && activeTherapistsCount > 0 ? 'Full coverage' : (shiftsTodayCount + ' of ' + activeTherapistsCount + ' scheduled')}</div></div><div className="stat-icon" style={{ background: '#DCFCE7', color: '#10B981' }}><i className="fa-solid fa-clock" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #EF4444' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Conflict Flags</div><div className="stat-value">{scheduleConflicts}</div><div className={scheduleConflicts > 0 ? 'stat-change down' : 'stat-change up'}>{scheduleConflicts > 0 ? 'Needs resolution' : 'No conflicts'}</div></div><div className="stat-icon" style={{ background: '#FEE2E2', color: '#EF4444' }}><i className="fa-solid fa-triangle-exclamation" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #818CF8' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Off Today</div><div className="stat-value">{offTodayCount}</div><div className="stat-change up">{offTodayCount > 0 ? 'Therapists on day off' : 'Everyone on shift'}</div></div><div className="stat-icon" style={{ background: '#EDE9FE', color: '#818CF8' }}><i className="fa-solid fa-user-clock" /></div></div></div>
        </div>

        <div className="sched-grid">
          {/* 3.2.1 View intricate therapist shift schedules */}
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div><div className="section-title">Therapist Shift Schedules</div><div className="section-sub">View intricate therapist shift schedules</div></div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} defaultValue="All Departments"><option>All Departments</option><option>Occupational Therapy</option><option>Speech Therapy</option></select>
                <button className="btn-primary" onClick={exportShiftSchedule}><i className="fa-solid fa-download" style={{ marginRight: 4 }} />Export</button>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th style={{ paddingLeft: 24 }}>Therapist</th><th>Shift Start</th><th>Shift End</th><th>Status</th><th style={{ paddingRight: 24, textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {shifts.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: '28px 24px', color: '#94A3B8', fontSize: 12.5 }}>No therapist accounts yet, add therapists in User Management to schedule shifts.</td></tr>
                  ) : shifts.map(s => (
                    <tr key={s.therapist_id}><td style={{ paddingLeft: 24 }}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="act-avatar" style={{ width: 30, height: 30, background: s.bg, color: s.color, fontSize: 11 }}>{s.initials}</div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{s.name}</div></div></td><td>{s.start}</td><td>{s.end}</td><td><span className={s.statusPill}>{s.status}</span></td><td style={{ paddingRight: 24, textAlign: 'right' }}><button className="btn-edit" onClick={() => openModal('edit-shift', { name: s.name, start_hour: s.start_hour, end_hour: s.end_hour, onSave: patch => saveShift(s.therapist_id, patch) })}>Edit Shift</button></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '10px 24px 16px', fontSize: 11.5, color: '#94A3B8' }}>
              <i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Shifts control booking availability: each hour offers as many reservation slots as there are therapists on shift, and sessions are auto-assigned to whoever is free.
            </div>
          </div>

          {/* 3.2.2 Manage therapist availability matrices */}
          <div className="card" style={{ padding: '22px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div><div className="section-title">Availability Matrix</div><div className="section-sub">Manage therapist availability</div></div>
              <button className="btn-primary" onClick={saveMatrix} disabled={matrixSaving}><i className={'fa-solid ' + (matrixSaving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 4 }} />{matrixSaving ? 'Saving…' : 'Save'}</button>
            </div>
            {/* Weekly grid */}
            <div style={{ overflowX: 'auto', marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    <th style={{ padding: '8px 10px', textAlign: 'left', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Therapist</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Mon</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Tue</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Wed</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Thu</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Fri</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Sat</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Sun</th>
                  </tr>
                </thead>
                <tbody id="avail-matrix">
                  {shifts.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: '24px 10px', color: '#94A3B8', fontSize: 12 }}>No therapist accounts yet.</td></tr>
                  ) : shifts.map((s, rowIdx) => (
                    <tr key={s.therapist_id} style={rowIdx % 2 === 1 ? { background: '#F8FAFC' } : undefined}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: '#0F172A', fontSize: 12 }}>{s.name}</td>
                      {daysFor(s).map((working, dayIdx) => (
                        <td key={dayIdx} style={{ textAlign: 'center', padding: 6 }}><span className="avail-dot" style={{ background: working ? DOT_COLORS.available : DOT_COLORS.off }} onClick={() => toggleDay(s, dayIdx)} title={working ? 'Available, click to set day off' : 'Day off, click to set available'} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#64748B' }}><span className="avail-dot" style={{ background: '#22C55E', pointerEvents: 'none', width: 12, height: 12 }} /> Available</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#64748B' }}><span className="avail-dot" style={{ background: '#E2E8F0', pointerEvents: 'none', width: 12, height: 12 }} /> Day off</div>
              <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 4 }}>· Click a dot to toggle, then Save. Day-off therapists add no booking slots that day; affected bookings are flagged and parents notified.</span>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════ SECTION 3.3, FINANCIAL TRANSACTIONS ═══════════════ */}
      <div id="section-financial" style={{ display: section === 'financial' ? '' : 'none' }}>
        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16, marginBottom: 24 }}>
          <div className="card stat-card" style={{ borderTop: '3px solid #10B981' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Monthly Revenue</div><div className="stat-value" style={{ fontSize: 22 }}>₱{collected.toLocaleString()}</div><div className="stat-change up">Collected this month</div></div><div className="stat-icon" style={{ background: '#DCFCE7', color: '#10B981' }}><i className="fa-solid fa-peso-sign" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #0EA5E9' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Sealed Transactions</div><div className="stat-value">{sealedCount}</div><div className="stat-change up">Locked in database</div></div><div className="stat-icon" style={{ background: '#E0F2FE', color: '#0EA5E9' }}><i className="fa-solid fa-lock" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #F59E0B' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Outstanding Balances</div><div className="stat-value">{outstandingCount}</div><div className="stat-change down">Needs follow-up</div></div><div className="stat-icon" style={{ background: '#FEF3C7', color: '#F59E0B' }}><i className="fa-solid fa-clock" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #818CF8' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Pending Review</div><div className="stat-value">{awaitingSealCount}</div><div className="stat-change down">Awaiting admin lock</div></div><div className="stat-icon" style={{ background: '#EDE9FE', color: '#818CF8' }}><i className="fa-solid fa-triangle-exclamation" /></div></div></div>
        </div>

        {/* 3.3.1 Track clinical billings and accounts */}
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="section-title"><i className="fa-solid fa-file-invoice-dollar" style={{ color: '#10B981', marginRight: 7 }} />Clinical Billing &amp; Accounts</div>
              <div className="section-sub">Track clinical billings and accounts across all client families</div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ position: 'relative' }}><i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8', fontSize: 11 }} /><input id="fin-search" type="text" className="filter-input" placeholder="Search name or invoice…" style={{ paddingLeft: 28, height: 34, fontSize: 12.5, width: 180 }} value={finQuery} onChange={e => setFinQuery(e.target.value)} /></div>
              <select id="fin-status" className="form-select" style={{ width: 120, height: 34, fontSize: 12.5 }} value={finStatus} onChange={e => setFinStatus(e.target.value)}>
                <option value="">All Status</option><option value="Paid">Paid</option><option value="Pending">Pending</option><option value="Overdue">Overdue</option>
              </select>
              <select id="fin-month" className="form-select" style={{ width: 120, height: 34, fontSize: 12.5 }} value={finMonth} onChange={e => setFinMonth(e.target.value)}>
                <option value="">All Months</option>
                {[...new Set(fin.map(r => r.month).filter(Boolean))].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <button className="btn-primary" onClick={() => toast('Billing report exported as PDF', 'fa-file-pdf')}><i className="fa-solid fa-download" style={{ marginRight: 4 }} />Export</button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 24 }}>Client</th>
                  <th>Date</th>
                  <th>Therapy</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center', paddingRight: 24 }}>Record</th>
                </tr>
              </thead>
              <tbody>
                {finLoading ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '32px 24px', color: '#64748B', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading transactions…</td></tr>
                ) : visibleFin.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '32px 24px', color: '#94A3B8', fontSize: 12.5 }}>No transactions match your search or filters.</td></tr>
                ) : visibleFin.map(r => (
                  <tr key={r.id} className="fin-row" data-client={r.client} data-inv={r.inv} data-status={r.status} data-month={r.month}>
                    <td style={{ paddingLeft: 24 }}><div style={{ fontWeight: 600, color: '#0F172A', fontSize: 13 }}>{r.client}</div><div style={{ fontSize: 11, color: '#94A3B8' }}>{r.guardian} · {r.inv}</div></td>
                    <td style={{ fontSize: 12.5 }}>{r.date}</td>
                    <td><span className={r.therapyPill}>{r.therapy}</span></td>
                    <td style={{ fontWeight: 700, color: '#0F172A' }}>{r.amount}</td>
                    <td><span className={r.methodPill} style={r.methodStyle || { fontSize: 10 }}><i className={'fa-solid ' + r.methodIcon} style={{ marginRight: 3 }} />{r.method}</span></td>
                    <td><span className={'pill ' + (PAY_CLASSES[r.statusKey] || 'pill-gray') + ' pay-status'} style={{ cursor: r.sealed ? 'default' : 'pointer' }} title={r.sealed ? 'Sealed, status is locked' : 'Click to change status'} onClick={() => cyclePayment(r.id)}>{r.status}</span></td>
                    <td style={{ textAlign: 'center', paddingRight: 24 }}>
                      {r.sealed
                        ? <span className="lock-badge"><i className="fa-solid fa-lock" style={{ fontSize: 9, marginRight: 3 }} />Sealed</span>
                        : r.recordAction === 'followup'
                          ? <button className="btn-danger" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => toast('Payment follow-up flagged for ' + r.client, 'fa-flag')}><i className="fa-solid fa-flag" style={{ marginRight: 3 }} />Follow-up</button>
                          : <button className="btn-edit" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => sealTransaction(r.id, r.client, r.inv)}><i className="fa-solid fa-lock" style={{ marginRight: 3 }} />Seal</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '14px 24px', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>Showing {visibleFin.length} of {fin.length} transactions</span>
            <div className="pagination"><button className="page-btn active">1</button></div>
          </div>
        </div>

        {/* 3.3.2 Billing Summary + Recent Sealed */}
        <div className="fin-summary-grid">
          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-chart-pie" style={{ color: '#818CF8', marginRight: 7 }} />Billing Summary: {monthName}</div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Total Billed</span><span style={{ fontWeight: 700, color: '#0F172A', fontFamily: "'Poppins',sans-serif" }}>₱{totalBilled.toLocaleString()}</span></div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Collected</span><span style={{ fontWeight: 700, color: '#16A34A', fontFamily: "'Poppins',sans-serif" }}>₱{collected.toLocaleString()}</span></div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Outstanding</span><span style={{ fontWeight: 700, color: '#B45309', fontFamily: "'Poppins',sans-serif" }}>₱{outstanding.toLocaleString()}</span></div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Overdue</span><span style={{ fontWeight: 700, color: '#DC2626', fontFamily: "'Poppins',sans-serif" }}>₱{overdueTotal.toLocaleString()}</span></div>
            <div style={{ height: 1, background: '#F1F5F9', margin: '10px 0' }} />
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Sealed records</span><span className="pill pill-green">{sealedCount} locked</span></div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Awaiting seal</span><span className="pill pill-amber">{awaitingSealCount} pending</span></div>
            <div className="status-row" style={{ borderBottom: 'none' }}><span style={{ fontSize: 13, color: '#475569' }}>Database</span><span className="pill pill-blue">Synced</span></div>
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={sealAllVerified}><i className="fa-solid fa-lock" style={{ marginRight: 4 }} />Seal All Verified</button>
              <button className="btn-secondary" onClick={() => toast('Pending transactions exported', 'fa-file-export')}><i className="fa-solid fa-file-export" style={{ marginRight: 4 }} />Export Pending</button>
            </div>
          </div>
          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 14 }}><i className="fa-solid fa-receipt" style={{ color: '#0D9488', marginRight: 7 }} />Recently Sealed</div>
            {recentlySealed.length === 0 ? (
              <div style={{ padding: '12px 0', color: '#94A3B8', fontSize: 12.5 }}>No sealed transactions yet.</div>
            ) : recentlySealed.map((r, i) => (
              <div key={r.id} className="act-item" style={i === recentlySealed.length - 1 ? { borderBottom: 'none' } : undefined}>
                <div className="act-avatar" style={{ background: '#DCFCE7', color: '#16A34A' }}><i className="fa-solid fa-lock" style={{ fontSize: 12 }} /></div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{r.client}</div><div className="act-meta">{r.inv} · {r.amount} · {r.method} · {r.date}</div></div>
                <span className="lock-badge"><i className="fa-solid fa-lock" style={{ fontSize: 8, marginRight: 3 }} />Sealed</span>
              </div>
            ))}
          </div>
        </div>
      </div>{/* end section-financial */}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Administrative Information Management</span></div>
    </div>
  );
}

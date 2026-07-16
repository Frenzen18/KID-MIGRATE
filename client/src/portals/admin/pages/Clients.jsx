import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api.js';
import { Modal } from '../../../components/ui.jsx';
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
  const therapyType = c.therapy_type || null;
  const thxPill = therapyType === 'Speech' ? 'pill pill-teal' : therapyType ? 'pill pill-blue' : '';

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
  const [gasEntries, setGasEntries] = useState([]);
  const [gasLoading, setGasLoading] = useState(false);
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

  /* Therapist list for the "Edit Client" assign-therapist dropdown only, the
     full shift-schedule/availability-matrix UI moved to Booking and
     Appointment's Employee Scheduling tab, this is just name+role. */
  const [therapistList, setTherapistList] = useState([]);
  useEffect(() => { if (!scopeToTherapist) api('/shifts').then(setTherapistList).catch(() => {}); }, [scopeToTherapist]);

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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Client Records Management</h1>
        </div>
      </div>

      {/* Section Tabs: 3.1 / 3.2 / 3.3 */}
      <div className="tab-nav">
        <button className={'section-tab' + (section === 'clients' ? ' active' : '')} onClick={() => setSection('clients')}><i className="fa-solid fa-child" style={{ marginRight: 6 }} />Client Records &amp; Profiles</button>
      </div>

      {/* ═══════════════ SECTION 3.1, CLIENT RECORDS ═══════════════ */}
      <div id="section-clients" style={{ display: section === 'clients' ? '' : 'none' }}>
        <div className="card dir-card">
          <div className="dir-head">
            <div><div className="section-title">Client Profile</div></div>
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
                    <div className="cd-cell">
                      {(c.thxName !== '–' || c.thxType) && (
                        <>
                          <span className="cd-name" style={{ fontWeight: 500 }}>{c.thxName !== '–' ? c.thxName + ' ' : ''}</span>
                          {c.thxType && <span className={c.thxPill} style={{ fontSize: 10 }}>{c.thxType}</span>}
                        </>
                      )}
                    </div>
                    <div className="cd-cell"><span className={c.statusPill}>{c.status}</span></div>
                    <div className="cd-actions" onClick={e => e.stopPropagation()}>
                      {!scopeToTherapist && (
                        <button className="btn-edit" onClick={() => { openModal('edit-client', { name: c.name, guardian: c.guardian, status: c.status, thxName: c.assigned_therapist_name, therapy_type: c.therapy_type, therapists: therapistList, onSave: async (patch) => {
                          try {
                            const body = {};
                            if (patch.name) body.full_name = patch.name;
                            if (patch.guardian) body.guardian_name = patch.guardian;
                            if (patch.status) body.status = patch.status.toLowerCase();
                            if ('therapy_type' in patch) body.therapy_type = patch.therapy_type || null;
                            if ('thxName' in patch) body.assigned_therapist_name = patch.thxName || null;
                            await api('/clients/' + c.id, { method: 'PUT', body });
                            toast('Client profile updated: ' + (patch.name || c.name), 'fa-check');
                            fetchClients();
                          } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); }
                        } }); }} title="Edit"><i className="fa-solid fa-pen" /></button>
                      )}
                      {role === 'admin' && (
                        <button className="btn-archive" onClick={() => { openModal('delete-client', { name: c.name, onConfirm: async () => {
                          try {
                            await api('/clients/' + c.id, { method: 'DELETE' });
                            toast('Client profile archived', 'fa-box-archive');
                            fetchClients();
                          } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); }
                        } }); }} title="Archive"><i className="fa-solid fa-box-archive" /></button>
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
                {!scopeToTherapist && <button className="btn-edit" onClick={() => { const c = clients.find(cl => cl.id === selectedId); openModal('edit-client', c ? { name: c.name, guardian: c.guardian, status: c.status, thxName: c.assigned_therapist_name, therapy_type: c.therapy_type, therapists: therapistList, onSave: async (patch) => { try { const body = {}; if (patch.name) body.full_name = patch.name; if (patch.guardian) body.guardian_name = patch.guardian; if (patch.status) body.status = patch.status.toLowerCase(); if ('therapy_type' in patch) body.therapy_type = patch.therapy_type || null; if ('thxName' in patch) body.assigned_therapist_name = patch.thxName || null; await api('/clients/' + c.id, { method: 'PUT', body }); toast('Client profile updated', 'fa-check'); fetchClients(); closeClientModal(); } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); } } } : { name: profile.name }); }}><i className="fa-solid fa-pen" style={{ marginRight: 4 }} />Edit</button>}
                {role === 'admin' && <button className="btn-archive" onClick={() => openModal('delete-client', { name: profile.name, onConfirm: async () => { if (!selectedId) return; try { await api('/clients/' + selectedId, { method: 'DELETE' }); toast('Client profile archived', 'fa-box-archive'); closeClientModal(); fetchClients(); } catch (err) { toast('Error: ' + err.message, 'fa-triangle-exclamation'); } } })}><i className="fa-solid fa-box-archive" style={{ marginRight: 4 }} />Archive</button>}
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
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Allergies</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.allergies}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Medications</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.medications}</div></div>
                  <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Emergency Contact</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{profile.guardian}</div></div>
                </div>
              </div>
            </div>
            {/* Assigned Therapist, unassigned shows a muted "not yet assigned" state instead of a
                bare "–" standing in for both the avatar initials and the name, which read like
                missing data rather than an intentional empty state. */}
            <div style={{ padding: '14px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
              {profile.thxName !== '–' ? (
                <>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: '#DBEAFE', color: '#2563EB', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{profile.thxInitials}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px' }}>Assigned Therapist</div>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>{profile.thxName}</div>
                    <div style={{ fontSize: 12, color: '#64748B' }}>{profile.thxType === 'Speech' ? 'Speech-Language Pathologist' : 'Occupational Therapist'}</div>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: '#F1F5F9', color: '#94A3B8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, flexShrink: 0 }}><i className="fa-solid fa-user-slash" /></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px' }}>Assigned Therapist</div>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: '#94A3B8' }}>Not yet assigned</div>
                  </div>
                </>
              )}
            </div>
            {/* Development & Functional Information */}
            <div style={{ padding: '16px 18px', borderRadius: 12, border: '1px solid #E2E8F0', background: '#FAFBFC', marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0F172A', display: 'flex', alignItems: 'center', gap: 6 }}><i className="fa-solid fa-child-reaching" style={{ color: '#4F46E5' }} />Development &amp; Functional Information</div>
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

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Client Records Management</span></div>
    </div>
  );
}

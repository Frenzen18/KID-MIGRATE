import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
// Staff/OT/Speech get the same report generator as admin, except Security Audit
// and Client Milestone Progress (clinical/security data), gated per-route below.
router.use(requireAuth, requireRole('admin', 'staff', 'ot', 'speech'));

/** Every report response is normalized to { title, range, summary, columns, rows }
 *  so the client can render/CSV-export/print any of them with one generic component. */

/** ?from=&to=, defaults to the calendar month containing `to` (or today). */
function dateRange(req) {
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const d = new Date(to + 'T00:00:00');
  const from = req.query.from || new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  return { from, to };
}
const endOfDay = to => to + 'T23:59:59.999';

/** GET /api/reports/summary?from=&to=, sessions, enrollments, revenue, avg milestone for the period */
router.get('/summary', async (req, res) => {
  const { from, to } = dateRange(req);
  const [{ data: clients, error: cErr }, { data: reservations, error: rErr }, { data: notes, error: nErr }, { data: payments, error: pErr }] = await Promise.all([
    db.from('clients').select('id, created_at').eq('archived', false),
    db.from('reservations').select('id, status').gte('date', from).lte('date', to),
    db.from('session_notes').select('score').gte('session_date', from).lte('session_date', to),
    db.from('payments').select('amount, status').gte('created_at', from).lte('created_at', endOfDay(to))
  ]);
  if (cErr) return res.status(500).json({ error: cErr.message });
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (nErr) return res.status(500).json({ error: nErr.message });
  if (pErr) return res.status(500).json({ error: pErr.message });

  const newEnrollments = (clients || []).filter(c => c.created_at >= from && c.created_at <= endOfDay(to)).length;
  const sessionsHeld = (reservations || []).filter(r => ['confirmed', 'completed'].includes(r.status)).length;
  const cancelled = (reservations || []).filter(r => r.status === 'cancelled').length;
  const declined = (reservations || []).filter(r => r.status === 'declined').length;
  const revenue = (payments || []).filter(p => p.status === 'paid').reduce((s, p) => s + Number(p.amount), 0);
  const avgMilestone = notes.length ? Math.round(notes.reduce((s, n) => s + n.score, 0) / notes.length) : null;

  const rows = [
    { metric: 'Sessions Held (confirmed/completed)', value: String(sessionsHeld) },
    { metric: 'New Enrollments', value: String(newEnrollments) },
    { metric: 'Revenue Collected', value: '₱' + revenue.toLocaleString() },
    { metric: 'Avg Milestone Completion', value: avgMilestone != null ? avgMilestone + '%' : '-' },
    { metric: 'Cancelled Sessions', value: String(cancelled) },
    { metric: 'Declined Requests', value: String(declined) }
  ];
  res.json({
    title: 'Monthly Summary', range: { from, to },
    summary: rows.map(r => ({ label: r.metric, value: r.value })),
    columns: [{ key: 'metric', label: 'Metric' }, { key: 'value', label: 'Value' }],
    rows
  });
});

const isOT = t => /occupational|\bOT\b/i.test(t || '');
const isSpeech = t => /speech/i.test(t || '');
const ROLE_DISCIPLINE = { ot: 'Occupational Therapy', speech: 'Speech-Language Therapy' };

/**
 * GET /api/reports/dashboard?from=&to=, reproduces exactly what the live Admin
 * Dashboard shows (Milestone Trends' GAS data, Employee Statistics, Demographics)
 * instead of a differently-scoped diagnosis/case-status breakdown, so
 * generating this report gives admins the same numbers as their homepage.
 * An ot/speech account only gets their own discipline's GAS trend, Employee
 * Statistics/Demographics are admin/staff-only, same as the live dashboard.
 * Staff gets no GAS trend at all, their live dashboard dropped that tab
 * (front-desk/billing role, not clinical).
 * Team/demographic snapshots are current-state (not date-filtered), matching
 * the live dashboard; only the GAS trend respects the from/to range.
 */
router.get('/dashboard', async (req, res) => {
  const { from, to } = dateRange(req);
  const lockedDiscipline = ROLE_DISCIPLINE[req.user.role] || null;
  const showGas = req.user.role !== 'staff';

  let gasTrend = null;
  if (showGas) {
    let gasQ = db.from('gas_entries').select('session_date, discipline, gas_t_score')
      .eq('archived', false)
      .gte('session_date', from).lte('session_date', to).order('session_date', { ascending: true });
    if (lockedDiscipline) gasQ = gasQ.eq('discipline', lockedDiscipline);
    const { data: gasEntries, error: gasErr } = await gasQ;
    if (gasErr) return res.status(500).json({ error: gasErr.message });

    const buckets = {};
    for (const e of gasEntries || []) {
      const month = e.session_date?.slice(0, 7);
      if (!month || e.gas_t_score == null) continue;
      const b = (buckets[month] = buckets[month] || { ot: [], speech: [] });
      if (e.discipline === 'Occupational Therapy') b.ot.push(e.gas_t_score);
      else if (e.discipline === 'Speech-Language Therapy') b.speech.push(e.gas_t_score);
    }
    const months = Object.keys(buckets).sort();
    const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10 : null;
    gasTrend = {
      months: months.map(m => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' })),
      ot: months.map(m => avg(buckets[m].ot)),
      speech: months.map(m => avg(buckets[m].speech)),
      otCount: (gasEntries || []).filter(e => e.discipline === 'Occupational Therapy').length,
      speechCount: (gasEntries || []).filter(e => e.discipline === 'Speech-Language Therapy').length
    };
  }

  let employees = null, demo = null;
  if (!lockedDiscipline) {
    const [{ data: therapists, error: tErr }, { data: reservations, error: rErr }] = await Promise.all([
      db.from('profiles').select('id, full_name, role').in('role', ['ot', 'speech']).eq('active', true),
      db.from('reservations').select('client_id, therapist_name, session_type, status')
    ]);
    if (tErr) return res.status(500).json({ error: tErr.message });
    if (rErr) return res.status(500).json({ error: rErr.message });

    const activeRes = (reservations || []).filter(r => !['cancelled', 'declined'].includes(r.status));
    const rows = (therapists || []).map(t => {
      const own = activeRes.filter(r => r.therapist_name === t.full_name);
      const ot = own.some(r => isOT(r.session_type));
      const sp = own.some(r => isSpeech(r.session_type));
      // Fall back to the therapist's declared role when session history doesn't
      // clearly show OT/Speech, every row here already has role 'ot' or
      // 'speech', so this should never actually read "Unassigned".
      const specialty = ot && sp ? 'Both' : sp ? 'Speech' : ot ? 'OT' : (t.role === 'speech' ? 'Speech' : 'OT');
      return { name: t.full_name, specialty, totalSessions: own.length, clients: new Set(own.map(r => r.client_id)).size };
    }).sort((a, b) => b.totalSessions - a.totalSessions);

    const specialtyCounts = { OT: 0, Speech: 0, Both: 0, Unassigned: 0 };
    for (const r of rows) specialtyCounts[r.specialty]++;
    employees = { total: (therapists || []).length, specialtyCounts, teamSessionsTotal: rows.reduce((s, r) => s + r.totalSessions, 0), rows };

    const { data: clients, error: clErr } = await db.from('clients').select('gender, dob').eq('archived', false);
    if (clErr) return res.status(500).json({ error: clErr.message });
    const gender = { Male: 0, Female: 0, Unspecified: 0 };
    const ageBrackets = { '3-4': 0, '5-6': 0, '7-8': 0, '9+': 0 };
    const now = Date.now();
    for (const c of clients || []) {
      const g = (c.gender || '').toLowerCase();
      if (g === 'male') gender.Male++;
      else if (g === 'female') gender.Female++;
      else gender.Unspecified++;
      if (!c.dob) continue;
      const ageYears = (now - new Date(c.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (ageYears < 5) ageBrackets['3-4']++;
      else if (ageYears < 7) ageBrackets['5-6']++;
      else if (ageYears < 9) ageBrackets['7-8']++;
      else ageBrackets['9+']++;
    }
    demo = { total: (clients || []).length, gender, ageBrackets };
  }

  const summary = [
    { label: 'Active Therapists', value: employees ? String(employees.total) : '-' },
    { label: 'Team Sessions (all-time)', value: employees ? String(employees.teamSessionsTotal) : '-' },
    { label: 'Total Clients', value: demo ? String(demo.total) : '-' }
  ];
  if (gasTrend) summary.push({ label: 'GAS Entries (OT / Speech)', value: `${gasTrend.otCount} / ${gasTrend.speechCount}` });

  res.json({
    title: 'Dashboard Overview', range: { from, to },
    summary,
    gasTrend, employees, demo,
    columns: [], rows: []
  });
});

/** GET /api/reports/revenue?from=&to=, itemized invoices + collected/outstanding/refunded totals */
router.get('/revenue', async (req, res) => {
  const { from, to } = dateRange(req);
  const { data: payments, error } = await db.from('payments')
    .select('*, clients(full_name, client_code), reservations(session_type, date, time_slot)')
    .gte('created_at', from).lte('created_at', endOfDay(to))
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const paid = payments.filter(p => p.status === 'paid');
  const pending = payments.filter(p => p.status === 'pending' || p.status === 'overdue');
  const refunded = payments.filter(p => p.status === 'refunded');
  const byMethod = {};
  for (const p of paid) byMethod[p.method] = (byMethod[p.method] || 0) + Number(p.amount);

  res.json({
    title: 'Revenue Report', range: { from, to },
    summary: [
      { label: 'Total Collected', value: '₱' + paid.reduce((s, p) => s + Number(p.amount), 0).toLocaleString() },
      { label: 'Outstanding', value: '₱' + pending.reduce((s, p) => s + Number(p.amount), 0).toLocaleString() },
      { label: 'Refunded', value: '₱' + refunded.reduce((s, p) => s + Number(p.amount), 0).toLocaleString() },
      ...Object.entries(byMethod).map(([m, v]) => ({ label: 'via ' + m, value: '₱' + v.toLocaleString() }))
    ],
    columns: [
      { key: 'invoice_no', label: 'Invoice' }, { key: 'client', label: 'Client' }, { key: 'session', label: 'Session' },
      { key: 'method', label: 'Method' }, { key: 'amount', label: 'Amount' }, { key: 'status', label: 'Status' }, { key: 'date', label: 'Date' }
    ],
    rows: payments.map(p => ({
      invoice_no: p.invoice_no || p.id,
      client: p.clients?.full_name || '-',
      session: p.reservations ? `${p.reservations.session_type} · ${p.reservations.date}` : '-',
      method: p.method,
      amount: '₱' + Number(p.amount).toLocaleString(),
      status: p.status,
      date: (p.created_at || '').slice(0, 10)
    }))
  });
});

/**
 * GET /api/reports/milestones?client_id=&from=&to=, GAS (Goal Attainment Scaling)
 * longitudinal trend for one client (admin only). GAS trends are inherently
 * per-client (goal scales + T-score over time), so a client must be picked,  * this reuses the same entries/scores shape as GET /gas/entries so the client
 * can render it with the existing GasProgressChart component.
 */
router.get('/milestones', requireRole('admin'), async (req, res) => {
  const { from, to } = dateRange(req);
  const clientId = req.query.client_id;

  if (!clientId) {
    return res.json({
      title: 'Client Milestone Progress', range: { from, to },
      summary: [{ label: 'Client', value: 'Select a client to generate this report' }],
      gasEntries: [], columns: [], rows: []
    });
  }

  const { data: client } = await db.from('clients').select('full_name, client_code').eq('id', clientId).maybeSingle();
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { data: entries, error } = await db.from('gas_entries')
    .select('*').eq('client_id', clientId).eq('archived', false)
    .gte('session_date', from).lte('session_date', to)
    .order('session_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const { data: scores } = entries.length
    ? await db.from('gas_entry_scores').select('*').in('entry_id', entries.map(e => e.id))
    : { data: [] };
  const scoresByEntry = {};
  for (const s of scores || []) (scoresByEntry[s.entry_id] ||= []).push(s);
  const gasEntries = entries.map(e => ({ ...e, scores: scoresByEntry[e.id] || [] }));

  const tScores = gasEntries.map(e => e.gas_t_score).filter(v => v != null);
  const avgT = tScores.length ? Math.round((tScores.reduce((s, v) => s + v, 0) / tScores.length) * 10) / 10 : null;
  const disciplines = [...new Set(gasEntries.map(e => e.discipline))];

  res.json({
    title: `Client Milestone Progress, ${client.full_name}`,
    range: { from, to },
    summary: [
      { label: 'Client', value: `${client.full_name} (${client.client_code})` },
      { label: 'GAS Entries', value: String(gasEntries.length) },
      { label: 'Avg T-Score', value: avgT != null ? String(avgT) : '-' },
      { label: 'Discipline(s)', value: disciplines.join(', ') || '-' }
    ],
    gasEntries,
    columns: [], rows: []
  });
});

/**
 * GET /api/reports/therapists?from=&to=, sessions/clients handled per therapist for the period.
 * "Clients" is a therapist's caseload: the union of clients they've actually seen
 * (reservations in range) and clients explicitly assigned to them via the "Assigned
 * Therapist" field on the client profile, an admin can assign a client before any
 * session is ever booked, and that assignment must still count here (see
 * migration_add_assigned_therapist.sql).
 */
router.get('/therapists', async (req, res) => {
  const { from, to } = dateRange(req);
  const [{ data: therapists, error: tErr }, { data: reservations }, { data: assignedClients }] = await Promise.all([
    db.from('profiles').select('id, full_name').in('role', ['ot', 'speech']).eq('active', true),
    db.from('reservations').select('client_id, therapist_name, status').gte('date', from).lte('date', to),
    db.from('clients').select('id, assigned_therapist_name').not('assigned_therapist_name', 'is', null)
  ]);
  if (tErr) return res.status(500).json({ error: tErr.message });

  const activeRes = (reservations || []).filter(r => !['cancelled', 'declined'].includes(r.status));
  const rows = (therapists || []).map(t => {
    const own = activeRes.filter(r => r.therapist_name === t.full_name);
    const caseload = new Set(own.map(r => r.client_id));
    (assignedClients || []).forEach(c => { if (c.assigned_therapist_name === t.full_name) caseload.add(c.id); });
    return {
      therapist: t.full_name,
      sessions: String(own.length),
      _sessions: own.length,
      clients: String(caseload.size)
    };
  }).sort((a, b) => b._sessions - a._sessions).map(({ _sessions, ...r }) => r);

  res.json({
    title: 'Therapist Performance', range: { from, to },
    summary: [
      { label: 'Active Therapists', value: String((therapists || []).length) },
      { label: 'Total Sessions', value: String(activeRes.length) }
    ],
    columns: [
      { key: 'therapist', label: 'Therapist' }, { key: 'sessions', label: 'Sessions' },
      { key: 'clients', label: 'Clients' }
    ],
    rows
  });
});

/** GET /api/reports/reservations?from=&to=, bookings by status/channel for the period */
router.get('/reservations', async (req, res) => {
  const { from, to } = dateRange(req);
  const { data: reservations, error } = await db.from('reservations')
    .select('*, clients(full_name, client_code)')
    .gte('date', from).lte('date', to)
    .order('date');
  if (error) return res.status(500).json({ error: error.message });

  const byStatus = {};
  for (const r of reservations) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const byChannel = {};
  for (const r of reservations) {
    const c = r.channel === 'parent-portal' ? 'Parent Portal' : 'Staff-Entered';
    byChannel[c] = (byChannel[c] || 0) + 1;
  }

  res.json({
    title: 'Reservation Summary', range: { from, to },
    summary: [
      { label: 'Total Bookings', value: String(reservations.length) },
      ...Object.entries(byStatus).map(([s, v]) => ({ label: s[0].toUpperCase() + s.slice(1), value: String(v) })),
      ...Object.entries(byChannel).map(([c, v]) => ({ label: c, value: String(v) }))
    ],
    columns: [
      { key: 'client', label: 'Client' }, { key: 'date', label: 'Date' }, { key: 'time', label: 'Time' },
      { key: 'session_type', label: 'Session Type' }, { key: 'therapist', label: 'Therapist' },
      { key: 'status', label: 'Status' }, { key: 'channel', label: 'Channel' }
    ],
    rows: reservations.map(r => ({
      client: r.clients?.full_name || '-',
      date: r.date, time: r.time_slot,
      session_type: r.session_type,
      therapist: r.therapist_name || '-',
      status: r.status,
      channel: r.channel === 'parent-portal' ? 'Parent Portal' : 'Staff'
    }))
  });
});

export default router;

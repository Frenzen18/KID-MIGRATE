import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getTherapistShifts, labelToHour, worksOn } from './shifts.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'staff', 'ot', 'speech'));

const isOT = t => /occupational|\bOT\b/i.test(t || '');
const isSpeech = t => /speech/i.test(t || '');
/** Last `n` calendar months (oldest first) as { key: 'YYYY-MM', label: 'Jun' }. */
function lastMonths(n) {
  const now = new Date();
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: d.toLocaleString('en-US', { month: 'short' }) });
  }
  return months;
}

/** GET /api/analytics/summary, dashboard stat cards + 7.1a/7.1b breakdowns */
router.get('/summary', async (req, res) => {
  const [clientsR, resR, notesR, payR] = await Promise.all([
    db.from('clients').select('id, diagnosis, status, therapy_type').eq('archived', false),
    db.from('reservations').select('id, status, date'),
    db.from('session_notes').select('score'),
    db.from('payments').select('amount, status')
  ]);
  const clients = clientsR.data || [];
  const reservations = resR.data || [];
  const notes = notesR.data || [];
  const payments = payR.data || [];

  // 7.1.a, cases per diagnosis category
  const diagnosis = {};
  for (const c of clients) {
    const d = c.diagnosis || 'Unspecified';
    diagnosis[d] = (diagnosis[d] || 0) + 1;
  }
  // 7.1.b, case status: recovered / ongoing / discontinued
  const caseStatus = { active: 0, recovered: 0, discontinued: 0, on_hold: 0 };
  for (const c of clients) caseStatus[c.status] = (caseStatus[c.status] || 0) + 1;

  const avgMilestone = notes.length
    ? Math.round(notes.reduce((s, n) => s + (n.score || 0), 0) / notes.length)
    : 0;

  res.json({
    totalClients: clients.length,
    pendingReservations: reservations.filter(r => r.status === 'pending').length,
    confirmedThisWeek: reservations.filter(r => r.status === 'confirmed').length,
    avgMilestone,
    revenue: payments.filter(p => p.status === 'paid').reduce((s, p) => s + Number(p.amount || 0), 0),
    diagnosis,
    caseStatus,
    therapySplit: {
      OT: clients.filter(c => c.therapy_type === 'OT').length,
      Speech: clients.filter(c => c.therapy_type === 'Speech').length,
      Both: clients.filter(c => c.therapy_type === 'Both').length
    }
  });
});

/** GET /api/analytics/progress/:clientId, 7.1.d individual trend (per-domain series + notes + attendance) */
router.get('/progress/:clientId', async (req, res) => {
  const [{ data: client }, { data: notes }, { data: attendance }] = await Promise.all([
    db.from('clients').select('*').eq('id', req.params.clientId).single(),
    db.from('session_notes').select('*').eq('client_id', req.params.clientId).order('session_date'),
    db.from('attendance').select('*').eq('client_id', req.params.clientId).order('session_date')
  ]);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const domains = {};
  for (const n of notes || []) {
    (domains[n.domain] = domains[n.domain] || []).push({
      date: n.session_date, score: n.score, remark: n.remark, next_plan: n.next_plan,
      tags: n.tags || [], therapist: n.therapist_name
    });
  }
  const attended = (attendance || []).filter(a => a.attended).length;
  const missed = (attendance || []).length - attended;
  res.json({ client, domains, attendance: attendance || [], attended, missed });
});

/** GET /api/analytics/milestones?bracket=25|50|75|100, 7.1.c completion brackets */
router.get('/milestones', async (req, res) => {
  const { data: notes, error } = await db.from('session_notes').select('client_id, score, session_date, clients(full_name, client_code, therapy_type)');
  if (error) return res.status(500).json({ error: error.message });

  // latest average score per client
  const byClient = {};
  for (const n of notes || []) {
    (byClient[n.client_id] = byClient[n.client_id] || { info: n.clients, scores: [] }).scores.push(n);
  }
  const rows = Object.entries(byClient).map(([id, { info, scores }]) => {
    const latestDate = scores.reduce((m, s) => s.session_date > m ? s.session_date : m, '');
    const latest = scores.filter(s => s.session_date === latestDate);
    const pct = Math.round(latest.reduce((s, n) => s + n.score, 0) / latest.length);
    return { client_id: id, name: info?.full_name, code: info?.client_code, therapy: info?.therapy_type, pct };
  });

  const bracket = parseInt(req.query.bracket, 10);
  const filtered = bracket
    ? rows.filter(r => r.pct > bracket - 25 && r.pct <= bracket)
    : rows;
  res.json(filtered.sort((a, b) => b.pct - a.pct));
});

/** GET /api/analytics/milestone-trend, clinic-wide monthly completion % + smoothed trend, last 6 months */
router.get('/milestone-trend', async (req, res) => {
  const { data: notes, error } = await db.from('session_notes').select('score, session_date');
  if (error) return res.status(500).json({ error: error.message });

  const months = lastMonths(6);
  const byMonth = {};
  for (const n of notes || []) {
    if (!n.session_date) continue;
    const key = n.session_date.slice(0, 7);
    (byMonth[key] = byMonth[key] || []).push(n.score);
  }
  const completion = months.map(m => {
    const scores = byMonth[m.key] || [];
    return scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
  });
  // 3-month trailing average, a smoothed growth-velocity trend line
  const trend = completion.map((_, i) => {
    const window = completion.slice(Math.max(0, i - 2), i + 1).filter(v => v != null);
    return window.length ? Math.round(window.reduce((s, v) => s + v, 0) / window.length) : null;
  });

  res.json({ months: months.map(m => m.label), completion, trend, totalEntries: (notes || []).length });
});

/** GET /api/analytics/employees, per-therapist load/specialty + team headcount trend (7.2) */
router.get('/employees', async (req, res) => {
  const [{ data: therapists, error: tErr }, { data: reservations, error: rErr }, { data: notes, error: nErr }] = await Promise.all([
    db.from('profiles').select('id, full_name, role, created_at').in('role', ['ot', 'speech']).eq('active', true),
    db.from('reservations').select('client_id, therapist_name, session_type, status, date'),
    db.from('session_notes').select('therapist_name, score')
  ]);
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (nErr) return res.status(500).json({ error: nErr.message });

  const activeRes = (reservations || []).filter(r => !['cancelled', 'declined'].includes(r.status));
  const now = new Date();
  const curMonthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  const rows = (therapists || []).map(t => {
    const own = activeRes.filter(r => r.therapist_name === t.full_name);
    const ownNotes = (notes || []).filter(n => n.therapist_name === t.full_name);
    const ot = own.some(r => isOT(r.session_type));
    const sp = own.some(r => isSpeech(r.session_type));
    // "Both" reflects actually-observed mixed session history; otherwise fall
    // back to the therapist's own declared role, every row here already has
    // role 'ot' or 'speech', so this should never actually read "Unassigned"
    // (that was leftover from before the single 'therapist' role was split).
    const specialty = ot && sp ? 'Both' : sp ? 'Speech' : ot ? 'OT' : (t.role === 'speech' ? 'Speech' : 'OT');
    return {
      id: t.id,
      name: t.full_name,
      specialty,
      sessionsThisMonth: own.filter(r => (r.date || '').slice(0, 7) === curMonthKey).length,
      totalSessions: own.length,
      clients: new Set(own.map(r => r.client_id)).size,
      milestonePct: ownNotes.length ? Math.round(ownNotes.reduce((s, n) => s + n.score, 0) / ownNotes.length) : null
    };
  }).sort((a, b) => b.totalSessions - a.totalSessions);

  const specialtyCounts = { OT: 0, Speech: 0, Both: 0, Unassigned: 0 };
  for (const r of rows) specialtyCounts[r.specialty]++;

  const months = lastMonths(6);
  const headcount = months.map(m => {
    const cutoff = new Date(m.key + '-01T00:00:00Z');
    cutoff.setUTCMonth(cutoff.getUTCMonth() + 1);
    return (therapists || []).filter(t => new Date(t.created_at) < cutoff).length;
  });

  res.json({
    total: (therapists || []).length,
    specialtyCounts,
    teamSessionsThisMonth: rows.reduce((s, r) => s + r.sessionsThisMonth, 0),
    teamSessionsTotal: rows.reduce((s, r) => s + r.totalSessions, 0),
    headcountMonths: months.map(m => m.label),
    headcount,
    rows
  });
});

/** GET /api/analytics/demographics, client gender + age breakdown */
router.get('/demographics', async (req, res) => {
  const { data: clients, error } = await db.from('clients').select('gender, dob').eq('archived', false);
  if (error) return res.status(500).json({ error: error.message });

  const gender = { Male: 0, Female: 0, Unspecified: 0 };
  for (const c of clients || []) {
    const g = (c.gender || '').toLowerCase();
    if (g === 'male') gender.Male++;
    else if (g === 'female') gender.Female++;
    else gender.Unspecified++;
  }

  const ageBrackets = { '3-4': 0, '5-6': 0, '7-8': 0, '9+': 0 };
  let youngest = null, oldest = null;
  const now = Date.now();
  for (const c of clients || []) {
    if (!c.dob) continue;
    const ageYears = (now - new Date(c.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (ageYears < 5) ageBrackets['3-4']++;
    else if (ageYears < 7) ageBrackets['5-6']++;
    else if (ageYears < 9) ageBrackets['7-8']++;
    else ageBrackets['9+']++;
    if (youngest == null || ageYears < youngest) youngest = ageYears;
    if (oldest == null || ageYears > oldest) oldest = ageYears;
  }
  const fmtAge = y => y == null ? null : Math.round(y);

  res.json({ total: (clients || []).length, gender, ageBrackets, youngest: fmtAge(youngest), oldest: fmtAge(oldest) });
});

/**
 * GET /api/analytics/cross-caseload, 8.3: real detection of a client being
 * seen by someone other than their established (most-frequent) therapist.
 * Flags a department-boundary mismatch (OT vs Speech) as critical, and also
 * reports whether the session fell outside that therapist's actual shift.
 */
router.get('/cross-caseload', requireRole('admin'), async (req, res) => {
  const [{ data: reservations, error }, shifts] = await Promise.all([
    db.from('reservations').select('id, client_id, therapist_name, session_type, date, time_slot, status, clients(full_name, client_code)')
      .not('status', 'in', '(cancelled,declined)')
      .order('date', { ascending: false }),
    getTherapistShifts()
  ]);
  if (error) return res.status(500).json({ error: error.message });

  const shiftByName = Object.fromEntries(shifts.map(s => [s.name, s]));

  const byClient = {};
  for (const r of reservations || []) {
    if (!r.therapist_name) continue;
    (byClient[r.client_id] = byClient[r.client_id] || []).push(r);
  }

  const flags = [];
  for (const rows of Object.values(byClient)) {
    if (rows.length < 2) continue; // not enough history to establish a caseload
    const counts = {};
    for (const r of rows) counts[r.therapist_name] = (counts[r.therapist_name] || 0) + 1;
    const primary = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const primaryDept = (() => {
      const sample = rows.find(x => x.therapist_name === primary)?.session_type;
      return isSpeech(sample) ? 'Speech' : isOT(sample) ? 'OT' : null;
    })();

    for (const r of rows) {
      if (r.therapist_name === primary) continue;
      const rowDept = isSpeech(r.session_type) ? 'Speech' : isOT(r.session_type) ? 'OT' : null;
      const deptViolation = !!(primaryDept && rowDept && primaryDept !== rowDept);

      const shift = shiftByName[r.therapist_name];
      const hour = labelToHour(r.time_slot);
      const scheduleViolation = shift ? !(worksOn(shift, r.date) && hour != null && hour >= shift.start_hour && hour < shift.end_hour) : false;

      flags.push({
        reservation_id: r.id,
        date: r.date,
        time_slot: r.time_slot,
        therapist_name: r.therapist_name,
        primary_therapist: primary,
        client_name: r.clients?.full_name,
        client_code: r.clients?.client_code,
        session_type: r.session_type,
        scheduleViolation,
        deptViolation,
        severity: deptViolation ? 'critical' : 'flagged'
      });
    }
  }

  flags.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const staffCounts = {};
  for (const f of flags) staffCounts[f.therapist_name] = (staffCounts[f.therapist_name] || 0) + 1;
  const mostFlagged = Object.entries(staffCounts).sort((a, b) => b[1] - a[1])[0] || null;

  res.json({
    flags,
    stats: {
      total: flags.length,
      critical: flags.filter(f => f.severity === 'critical').length,
      scheduleViolations: flags.filter(f => f.scheduleViolation).length,
      mostFlaggedStaff: mostFlagged ? mostFlagged[0] : null,
      mostFlaggedCount: mostFlagged ? mostFlagged[1] : 0
    }
  });
});

export default router;

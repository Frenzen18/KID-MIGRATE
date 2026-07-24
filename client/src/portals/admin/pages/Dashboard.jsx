import { useState, useEffect, useRef } from 'react';
import { api } from '../../../api.js';
import { useAuth } from '../../../auth.jsx';

function greetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function calcAge(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  return age;
}

/** Splits `value`s of a pie into stroke-dasharray/dashoffset segments around a r=58 circle. */
function pieSegments(entries) {
  const r = 58;
  const circumference = 2 * Math.PI * r;
  const total = entries.reduce((s, e) => s + e.value, 0) || 1;
  let cumulative = 0;
  return entries.map(e => {
    const len = (e.value / total) * circumference;
    const seg = { ...e, dasharray: `${len.toFixed(1)} ${circumference.toFixed(1)}`, dashoffset: (-cumulative).toFixed(1), pct: Math.round((e.value / total) * 100) };
    cumulative += len;
    return seg;
  });
}

export function PieChart({ segments, size, centerValue, centerLabel }) {
  const segs = pieSegments(segments);
  const circumference = (2 * Math.PI * 58).toFixed(1);
  // Segments draw in from empty on mount/re-mount, a still pie chart reads as static
  // data; growing it in on load signals "this just loaded, it's real and current."
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    return () => cancelAnimationFrame(id);
  }, [segments.map(s => s.value).join(',')]);
  return (
    <div className="pie-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 160 160">
        <circle cx="80" cy="80" r="58" fill="none" stroke="#F1F5F9" strokeWidth="22" />
        {segs.map((s, i) => s.value > 0 && (
          <circle key={i} cx="80" cy="80" r="58" fill="none" stroke={s.color} strokeWidth="22"
            className="pie-seg"
            strokeDasharray={mounted ? s.dasharray : `0 ${circumference}`} strokeDashoffset={s.dashoffset} transform="rotate(-90 80 80)" />
        ))}
      </svg>
      <div className="pie-center chart-fade-in"><div className="pv">{centerValue}</div><div className="pl">{centerLabel}</div></div>
    </div>
  );
}

/** Euclidean length of a polyline given its [x,y] points, used to drive the line "draw-in" animation.
 *  The real curved path (see smoothPath) is a bit longer than this straight-segment sum, close enough
 *  for a draw-in animation's timing/masking, doesn't need to be exact. */
function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    len += Math.hypot(x2 - x1, y2 - y1);
  }
  return len;
}

/** Smooth Catmull-Rom-through-cubic-Bezier spline through [x,y,...] points, a
 *  flowing curve instead of the sharp-angle straight-segment polyline these
 *  charts used to draw, same look as the reference "modern SaaS dashboard"
 *  trend charts. Endpoints are clamped (repeats the first/last point as its
 *  own neighbor) so the curve doesn't overshoot past the first/last dot. */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]} `;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? i : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6, cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6, cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]} `;
  }
  return d;
}

/**
 * Multi-series line/dot chart. `series`: [{ name?, values, color, toneColors? }],
 * one value per label, each label is one real session/Milestone entry in the
 * order it happened (not averaged into a month bucket), so the line actually
 * moves session to session the way the underlying Session Entries data does.
 * `min`/`max` fix the y-axis to a known clinical scale (0-100 for a GAS
 * T-score, -2 to +2 for goal attainment level) instead of stretching to
 * whatever the current data happens to contain. `refLine`/`refLabel` draw a
 * dashed line at a clinically meaningful value (e.g. T=50 "expected outcome"),
 * a real mark on the chart instead of disconnected caption text.
 * `toneColors` (per series, optional): a color per data point instead of one
 * flat series color, used only where the color itself is the point (e.g. the
 * existing green/blue/amber/red GAS score bands elsewhere in this app) — not
 * used for Goal Scale Trend, where color is goal identity and must stay fixed.
 * `xIndices` (per series, optional): which label slot each value belongs to,
 * for when several entries share one slot (e.g. two sessions on the same
 * date, collapsed to one x position the way the per-client GAS Progress
 * chart in Client Records already does), so `labels` can be shorter than
 * `values`. Defaults to each value owning its own slot in order (`i`).
 */
export function TrendChart({ labels, series, height = 170, min: fixedMin, max: fixedMax, refLine, refLabel }) {
  // viewBox width tracks the wrapper's real rendered pixel width (measured via
  // ResizeObserver) instead of a fixed guess, so 1 user-space unit maps to 1
  // real pixel horizontally, same as height already does. A fixed width here
  // that doesn't match the actual container (wider on most screens) made
  // preserveAspectRatio="none" stretch everything non-uniformly, most visibly
  // squashing the round dot markers into flat ovals.
  const wrapRef = useRef(null);
  const [measuredWidth, setMeasuredWidth] = useState(560);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w) setMeasuredWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = measuredWidth, padTop = 16, padBottom = 24, padLeft = 34, padRight = 12;
  const allVals = series.flatMap(s => s.values).filter(v => v != null);
  // Lines draw themselves in left-to-right on mount, like a live readout arriving,   // a chart that just snaps into place reads as a static image, not real data.
  const [drawn, setDrawn] = useState(false);
  // Custom styled tooltip (mirrors GasProgressChart.jsx's own .cp-tip pattern) instead
  // of a bare native <title>, which is slow to appear, unstyled, and un-brandable.
  const [tip, setTip] = useState(null);
  const [hoverKey, setHoverKey] = useState(null);
  const dataKey = labels.join(',') + '|' + series.map(s => s.values.join(',')).join('|');
  useEffect(() => {
    setDrawn(false);
    setTip(null);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, [dataKey]);
  if (!allVals.length) {
    return <div style={{ padding: '48px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No data yet</div>;
  }
  const max = fixedMax != null ? fixedMax : Math.max(...allVals, 10);
  const min = fixedMin != null ? fixedMin : Math.min(0, ...allVals);
  const span = Math.max(1, max - min);
  const usableH = height - padTop - padBottom;
  const n = labels.length;
  const usableW = width - padLeft - padRight;
  const stepX = n > 1 ? usableW / (n - 1) : 0;
  const yFor = v => padTop + usableH - ((v - min) / span) * usableH;
  const xFor = i => padLeft + (n > 1 ? i * stepX : usableW / 2);
  const refY = refLine != null ? yFor(refLine) : null;

  function showTip(e, key, name, label, value) {
    setHoverKey(key);
    const wrap = e.currentTarget.closest('.cp-wrap')?.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (!wrap) return;
    setTip({ left: Math.max(90, Math.min(wrap.width - 90, r.left - wrap.left + r.width / 2)), top: r.top - wrap.top, name, label, value });
  }

  // Real axis ticks (min / the reference value, if it sits strictly between /
  // max) instead of blank decorative gridlines, so the scale is legible at a
  // glance rather than a mystery dashed line with a caption living elsewhere.
  const ticks = [{ v: max }, { v: min }];
  if (refLine != null && refLine > min && refLine < max) ticks.push({ v: refLine, ref: true });

  return (
    <div className="cp-wrap" ref={wrapRef} style={{ position: 'relative' }}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {ticks.map((t, i) => {
          const y = yFor(t.v);
          return (
            <g key={i}>
              <line x1={padLeft} y1={y} x2={width - padRight} y2={y} stroke={t.ref ? '#CBD5E1' : '#F1F5F9'} strokeWidth={t.ref ? 1.5 : 1} strokeDasharray={t.ref ? '5,4' : undefined} />
              <text x={padLeft - 6} y={y + 3.5} fontSize="10" fill={t.ref ? '#64748B' : '#94A3B8'} fontWeight={t.ref ? 700 : 400} textAnchor="end">{t.v}</text>
            </g>
          );
        })}
        {refLabel && refY != null && <text x={width - padRight} y={refY - 6} fontSize="9.5" fill="#94A3B8" textAnchor="end">{refLabel}</text>}
        {series.map((s, si) => {
          // 3rd element: index into values/toneColors (for the value itself). 4th: which
          // label slot this point sits at (for x position + the tooltip's date), the two
          // differ once several entries share one slot. A null reading skips a point but
          // must never shift what a later point's tooltip/x-position reads.
          const pts = s.values.map((v, i) => {
            const slot = s.xIndices ? s.xIndices[i] : i;
            return v == null ? null : [xFor(slot), yFor(v), i, slot];
          }).filter(Boolean);
          if (!pts.length) return null;
          const curve = smoothPath(pts);
          const len = polylineLength(pts) + 4;
          // Optional area wash under the line (opt-in per series), a plain
          // magnitude-over-time chart reads as a considered "volume" rather
          // than a bare wire when the space under it is gently filled. Follows
          // the same curve as the line above it, not straight segments under a
          // smooth line, closed off with two straight drops to the baseline.
          const areaPath = s.area && pts.length > 1
            ? curve + ` L${pts[pts.length - 1][0]},${yFor(min)} L${pts[0][0]},${yFor(min)} Z`
            : null;
          return (
            <g key={si}>
              {areaPath && (
                <path d={areaPath} fill={s.color} stroke="none" opacity={drawn ? 0.1 : 0} style={{ transition: 'opacity .5s ease .2s' }} />
              )}
              {pts.length > 1 && (
                <path d={curve} fill="none" stroke={s.color} strokeWidth="2.5"
                  strokeDasharray={`${len} ${len}`} strokeDashoffset={drawn ? 0 : len}
                  className="trend-line-draw" strokeLinecap="round" strokeLinejoin="round" />
              )}
              {pts.map(([x, y, valueIdx, slot], i) => {
                const v = s.values[valueIdx];
                const dotColor = (s.toneColors && s.toneColors[valueIdx]) || s.color;
                const key = si + '-' + i;
                const hovered = hoverKey === key;
                return (
                  <g key={i}>
                    <circle cx={x} cy={y} r={hovered ? 7.5 : pts.length === 1 ? 6 : i === pts.length - 1 ? 5 : 4}
                      fill={dotColor} stroke="#fff" strokeWidth={i === pts.length - 1 ? 2.5 : 2}
                      className="trend-point-in" style={{ animationDelay: (0.15 + i * 0.05) + 's', transition: 'r .15s ease' }} />
                    {/* Bigger invisible hit target, a 4-5px dot is too small to reliably hover/tap on its own. */}
                    <circle cx={x} cy={y} r="13" fill="transparent" style={{ cursor: 'pointer' }}
                      onMouseEnter={e => showTip(e, key, s.name, labels[slot], v)}
                      onMouseLeave={() => { setTip(null); setHoverKey(null); }} />
                  </g>
                );
              })}
              {/* Only the most recent reading's value, written right on the chart, not
                  just on hover, a single-series chart's latest point especially needs
                  to read as real data at a glance. Every point would be chaos on a
                  chart that can grow to many session entries over time. */}
              {series.length === 1 && pts.length > 0 && (() => {
                const [lx, ly, valueIdx] = pts[pts.length - 1];
                const dotColor = (s.toneColors && s.toneColors[valueIdx]) || s.color;
                return (
                  <text x={lx} y={ly - 11} fontSize="11" fontWeight="700" fill={dotColor} textAnchor="middle">
                    {s.values[valueIdx]}
                  </text>
                );
              })()}
            </g>
          );
        })}
        {labels.map((l, i) => (
          <text key={i} x={xFor(i)} y={height - 6} fontSize="10" fill="#94A3B8" textAnchor={n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{l}</text>
        ))}
      </svg>
      {tip && (
        <div className="cp-tip" style={{ left: tip.left, top: tip.top }}>
          {tip.name && <div style={{ fontWeight: 700, marginBottom: 2 }}>{tip.name}</div>}
          <div>{tip.label}: <b>{tip.value}</b></div>
        </div>
      )}
    </div>
  );
}

const ROLE_DISCIPLINE = { ot: 'Occupational Therapy', speech: 'Speech-Language Therapy' };
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BOOKING_STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-Show' }
];
// Color follows the status's own meaning (the same tokens the rest of the app
// already uses for these exact states), not an arbitrary series hue, so
// switching the filter reads as "now showing the cancelled ones" rather than
// a random repaint.
const BOOKING_STATUS_COLOR = { all: 'var(--cat-1)', completed: 'var(--color-success)', cancelled: 'var(--color-danger)', no_show: 'var(--color-warning)' };

/** Buckets raw {date,status} reservation rows into a week/month/year trend
 *  (count of bookings per bucket), optionally scoped to one status. Always
 *  returns a full, contiguous range ending at today (12 weeks / 6 months /
 *  6 years), a bucket with zero bookings still shows up as a real 0 point
 *  instead of just vanishing from the x-axis, otherwise a clinic with only
 *  one or two weeks of actual data renders as a single floating dot with
 *  nothing to draw a line between instead of an actual trend. */
function buildBookingTrend(bookings, period, status) {
  const rows = status === 'all' ? bookings : bookings.filter(b => b.status === status);
  const counts = {}; // key -> count, only for keys a booking actually landed in
  for (const b of rows) {
    if (!b.date) continue;
    const d = new Date(b.date + 'T00:00:00');
    let key;
    if (period === 'weekly') {
      // Monday-start ISO week, keyed by that Monday's date.
      const day = d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
      key = monday.toISOString().slice(0, 10);
    } else if (period === 'yearly') {
      key = String(d.getFullYear());
    } else {
      key = b.date.slice(0, 7);
    }
    counts[key] = (counts[key] || 0) + 1;
  }

  const bucketCount = period === 'weekly' ? 12 : 6;
  const keys = [], labels = [];
  const now = new Date();
  if (period === 'weekly') {
    const day = now.getDay();
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + ((day === 0 ? -6 : 1) - day));
    for (let i = bucketCount - 1; i >= 0; i--) {
      const monday = new Date(thisMonday);
      monday.setDate(thisMonday.getDate() - i * 7);
      keys.push(monday.toISOString().slice(0, 10));
      labels.push(monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }
  } else if (period === 'yearly') {
    const y = now.getFullYear();
    for (let i = bucketCount - 1; i >= 0; i--) {
      const key = String(y - i);
      keys.push(key);
      labels.push(key);
    }
  } else {
    const y = now.getFullYear(), m = now.getMonth();
    for (let i = bucketCount - 1; i >= 0; i--) {
      const dt = new Date(y, m - i, 1);
      keys.push(dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'));
      labels.push(MONTH_ABBR[dt.getMonth()] + ' ’' + String(dt.getFullYear()).slice(2));
    }
  }

  const values = keys.map(k => counts[k] || 0);
  return { labels, values, max: niceMax(Math.max(1, ...values) * 1.2) };
}

/** Rounds up to a clean axis-tick number (1/2/5/10/20/50/100…) with headroom
 *  baked into the input, so a chart's peak value never pins to the very top
 *  of the y-axis and the tick itself reads as a round, legible number. */
function niceMax(v) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(v)));
  const normalized = v / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export default function Dashboard({ go, toast, openModal, role = 'admin' }) {
  // An 'ot'/'speech' therapist only sees their own discipline's Milestone Trends,
  // that tab is now exclusively a therapist view, admin/staff instead get
  // Booking Operations in that same slot (clinic-wide concerns, not clinical).
  const lockedDiscipline = ROLE_DISCIPLINE[role] || null;
  const showMilestones = !!lockedDiscipline;
  const { user } = useAuth();
  const therapistName = user?.name || '';

  // A locked ot/speech account's own overall caseload, "My Patients": children
  // they've actually had a real (non-cancelled) session with, derived from
  // reservation history, plus any child an admin/staff explicitly assigned to
  // them via Edit Client Profile even before a first session, same "real
  // caseload" rule Client Records/Milestone Scoreboard already use.
  const [myPatients, setMyPatients] = useState([]);
  const [myPatientsLoading, setMyPatientsLoading] = useState(false);
  useEffect(() => {
    if (!lockedDiscipline || !therapistName) return;
    setMyPatientsLoading(true);
    Promise.all([
      api('/reservations?therapist_name=' + encodeURIComponent(therapistName)),
      api('/clients')
    ]).then(([res, clients]) => {
      const activeAppts = (res || []).filter(r => !['cancelled', 'declined'].includes(r.status));
      const myIds = new Set(activeAppts.map(r => r.client_id));
      const assignedField = role === 'speech' ? 'assigned_speech_therapist_name' : 'assigned_ot_therapist_name';
      for (const c of clients || []) if (c[assignedField] === therapistName) myIds.add(c.id);
      setMyPatients((clients || []).filter(c => myIds.has(c.id)));
    }).catch(() => setMyPatients([])).finally(() => setMyPatientsLoading(false));
  }, [lockedDiscipline, therapistName, role]);
  const anaTabStorageKey = 'kid_' + role + '_dashboard_anatab';
  const [anaTab, setAnaTab] = useState(() => {
    const validKeys = lockedDiscipline ? ['milestones'] : ['booking', 'employees', 'demographics'];
    const saved = localStorage.getItem(anaTabStorageKey);
    return validKeys.includes(saved) ? saved : (lockedDiscipline ? 'milestones' : 'booking');
  });
  useEffect(() => { localStorage.setItem(anaTabStorageKey, anaTab); }, [anaTab, anaTabStorageKey]);

  const [employees, setEmployees] = useState(null);
  const [demo, setDemo] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [gasTrend, setGasTrend] = useState(null); // { months, ot, speech }
  const [gasDistribution, setGasDistribution] = useState(null); // { ot, speech }: caseload-wide up/flat/down counts
  const [rawGasEntries, setRawGasEntries] = useState(null);
  const [bookings, setBookings] = useState(null); // raw [{date,status}] for Booking Trends
  const [bookingPeriod, setBookingPeriod] = useState('monthly'); // 'weekly'|'monthly'|'yearly'
  const [bookingStatus, setBookingStatus] = useState('all'); // 'all'|'cancelled'|'completed'|'no_show'

  useEffect(() => {
    if (!lockedDiscipline) {
      Promise.all([
        api('/analytics/employees'),
        api('/analytics/demographics'),
        api('/analytics/bookings')
      ]).then(([e, d, b]) => {
        setEmployees(e); setDemo(d); setBookings(b);
      }).catch(() => { setLoadErr(true); toast('Failed to load dashboard analytics', 'fa-triangle-exclamation'); });
    }

    if (!showMilestones) return;

    // GAS entries fetched separately so a failure doesn't block the rest of the dashboard.
    // Trend-building itself happens below, once this therapist's own caseload (myPatients)
    // is known, Milestone Trends must match their own Milestone Scoreboard, not the whole
    // discipline's entries across every therapist.
    api('/gas/entries' + (lockedDiscipline ? '?discipline=' + encodeURIComponent(lockedDiscipline) : ''))
      .then(setRawGasEntries)
      .catch(() => { /* GAS trend is optional, don't block dashboard */ });
  }, []);

  // Milestone Trends scoped to exactly the entries this therapist would see in their
  // own Milestone Scoreboard, their own caseload only, same rule "My Patients" above
  // and Milestones.jsx's Session Entries tab already use, instead of every therapist's
  // entries in the discipline. Admin/staff have no caseload of their own, unfiltered.
  // Waits for myPatients to finish loading so a locked account never flashes an empty
  // chart before its caseload (fetched by a separate effect above) arrives.
  useEffect(() => {
    if (!rawGasEntries) return;
    if (lockedDiscipline && myPatientsLoading) return;
    const caseloadIds = lockedDiscipline ? new Set(myPatients.map(c => c.id)) : null;
    const gasEntries = caseloadIds ? rawGasEntries.filter(e => caseloadIds.has(e.client_id)) : rawGasEntries;
    if (!gasEntries.length) { setGasTrend(null); setGasDistribution(null); return; }

    const GOAL_COLORS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)', 'var(--cat-7)', 'var(--cat-8)'];
    const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10 : null;

    // Month-over-month average goal level per named goal, one point per
    // calendar month, a whole new point appears once entries start landing
    // in a new month.
    function buildGoalTrend(disc) {
      const goalBuckets = {}; // goalName -> month -> levels[]
      const monthSet = new Set();
      for (const e of gasEntries) {
        if (e.discipline !== disc) continue;
        const month = e.session_date?.slice(0, 7);
        if (!month) continue;
        monthSet.add(month);
        for (const sc of (e.scores || [])) {
          const title = sc.item_title || 'Unknown Goal';
          if (sc.level == null) continue;
          goalBuckets[title] ||= {};
          (goalBuckets[title][month] ||= []).push(sc.level);
        }
      }
      const months = [...monthSet].sort().slice(-6);
      const labels = months.map(m => MONTH_ABBR[parseInt(m.split('-')[1], 10) - 1]);
      const goalSeries = Object.keys(goalBuckets).map((name, i) => ({
        name, color: GOAL_COLORS[i % GOAL_COLORS.length],
        values: months.map(m => avg(goalBuckets[name][m] || []))
      }));
      return { goalLabels: labels, goalSeries };
    }

    setGasTrend({
      ot: buildGoalTrend('Occupational Therapy'),
      speech: buildGoalTrend('Speech-Language Therapy'),
    });

    // Caseload-wide distribution: each client's own two most recent T-scores decide
    // their own up/flat/down bucket, then the caseload is summarized as counts in
    // each bucket. A single blended average line hides a caseload where half the
    // kids are improving and half are declining, they'd cancel out to "no change";
    // bucketing per client first and only summarizing after avoids that entirely.
    function buildDistribution(disc) {
      const byClient = {};
      for (const e of gasEntries) {
        if (e.discipline !== disc || e.gas_t_score == null) continue;
        (byClient[e.client_id] ||= []).push(e);
      }
      const MEANINGFUL_SHIFT = 5; // T-score points; smaller moves read as measurement noise, not a real trend
      let up = 0, flat = 0, down = 0, insufficient = 0;
      const upNames = [], downNames = [];
      for (const [clientId, entries] of Object.entries(byClient)) {
        entries.sort((a, b) => (a.session_date || '').localeCompare(b.session_date || ''));
        if (entries.length < 2) { insufficient++; continue; }
        const delta = entries[entries.length - 1].gas_t_score - entries[entries.length - 2].gas_t_score;
        const name = myPatients.find(c => c.id === clientId)?.full_name || 'Client';
        if (delta >= MEANINGFUL_SHIFT) { up++; upNames.push(name); }
        else if (delta <= -MEANINGFUL_SHIFT) { down++; downNames.push(name); }
        else flat++;
      }
      return { up, flat, down, insufficient, total: up + flat + down, upNames, downNames };
    }

    setGasDistribution({
      ot: buildDistribution('Occupational Therapy'),
      speech: buildDistribution('Speech-Language Therapy'),
    });
  }, [rawGasEntries, myPatients, myPatientsLoading, lockedDiscipline]);

  // A segmented pill pair reads and clicks faster than a native <select>, one
  // tap instead of open-dropdown-then-pick, and states its two options up
  // front instead of hiding "Per Session" behind a click to find out it exists.
  function SegmentedToggle({ value, onChange, options }) {
    return (
      <div style={{ display: 'inline-flex', gap: 2, padding: 2, background: '#F1F5F9', borderRadius: 9, border: '1px solid #E2E8F0', flexWrap: 'wrap' }}>
        {options.map(o => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              padding: '5px 12px', border: 'none', background: value === o.value ? '#0EA5E9' : 'transparent',
              color: value === o.value ? '#fff' : '#64748B', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              borderRadius: 7, transition: 'all .15s ease', whiteSpace: 'nowrap'
            }}
            onMouseEnter={e => { if (value !== o.value) e.currentTarget.style.background = '#EFF6FF'; }}
            onMouseLeave={e => { if (value !== o.value) e.currentTarget.style.background = 'transparent'; }}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  const empRows = employees?.rows || [];

  const genderTotal = demo ? demo.gender.Male + demo.gender.Female + demo.gender.Unspecified : 0;
  const ageTotal = demo ? Object.values(demo.ageBrackets).reduce((s, v) => s + v, 0) : 0;
  const peakAgeBracket = demo ? Object.entries(demo.ageBrackets).sort((a, b) => b[1] - a[1])[0] : null;

  // "No data yet" on its own is a dead end, an ot/speech account (the only
  // role with a Milestone Scoreboard to go to) gets a real next step instead.
  function EmptyGasState({ icon, text }) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
        <div><i className={'fa-solid ' + icon} style={{ marginRight: 6, opacity: 0.5 }}></i>{text}</div>
        {lockedDiscipline && (
          <button className="btn-edit" style={{ marginTop: 12 }} onClick={() => go('milestones')}>
            <i className="fa-solid fa-plus" style={{ marginRight: 5 }}></i>Log a session
          </button>
        )}
      </div>
    );
  }

  // Caseload-wide up/flat/down summary as a single proportional bar, each client
  // already bucketed by buildDistribution above; this only renders the summary.
  function TrendDistributionBar({ dist }) {
    if (!dist || dist.total === 0) return null;
    const pct = n => (n / dist.total) * 100;
    return (
      <>
        <div style={{ display: 'flex', height: 14, borderRadius: 8, overflow: 'hidden', background: '#F1F5F9' }}>
          {dist.up > 0 && <div style={{ width: pct(dist.up) + '%', background: '#16A34A' }} title={`${dist.up} trending up`}></div>}
          {dist.flat > 0 && <div style={{ width: pct(dist.flat) + '%', background: '#94A3B8' }} title={`${dist.flat} stable`}></div>}
          {dist.down > 0 && <div style={{ width: pct(dist.down) + '%', background: '#DC2626' }} title={`${dist.down} trending down`}></div>}
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div className="legend-dot" style={{ background: '#16A34A' }}></div><div><div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', lineHeight: 1.1 }}>{dist.up}</div><div style={{ fontSize: 11, color: '#64748B' }}>Trending Up</div></div></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div className="legend-dot" style={{ background: '#94A3B8' }}></div><div><div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', lineHeight: 1.1 }}>{dist.flat}</div><div style={{ fontSize: 11, color: '#64748B' }}>Stable</div></div></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div className="legend-dot" style={{ background: '#DC2626' }}></div><div><div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', lineHeight: 1.1 }}>{dist.down}</div><div style={{ fontSize: 11, color: '#64748B' }}>Trending Down</div></div></div>
        </div>
        {dist.down > 0 && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #F1F5F9' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#991B1B', marginBottom: 8 }}><i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 6 }}></i>Needs attention</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {dist.downNames.map(n => <span key={n} className="pill pill-red">{n}</span>)}
            </div>
          </div>
        )}
        {dist.insufficient > 0 && (
          <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 12 }}>
            {dist.insufficient} client{dist.insufficient === 1 ? '' : 's'} with only one session recorded, not enough history for a trend yet.
          </div>
        )}
      </>
    );
  }

  return (
    <div className="spa-page" id="spa-dashboard">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>{greetingWord()}, {user?.name || 'there'} 👋</h1>
        <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}><i className="fa-regular fa-calendar" style={{ marginRight: 5 }}></i>{new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>

      {/* MY PATIENTS, ot/speech only: their overall caseload at a glance */}
      {lockedDiscipline && (
        <div className="card" style={{ padding: '22px 24px', marginBottom: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div className="section-title"><i className="fa-solid fa-user-group" style={{ color: '#0EA5E9', marginRight: 7 }}></i>My Patients</div>
              <div className="section-sub">{myPatientsLoading ? 'Loading your caseload…' : `${myPatients.length} ${myPatients.length === 1 ? 'patient' : 'patients'} under your care`}</div>
            </div>
            <span className="pill pill-blue" style={{ cursor: 'pointer' }} onClick={() => go('clients')}>View all in Client Records <i className="fa-solid fa-arrow-right" style={{ marginLeft: 4 }}></i></span>
          </div>
          {myPatientsLoading ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }}></i>Loading…</div>
          ) : myPatients.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {myPatients.map(c => {
                const age = calcAge(c.dob);
                const initials = (c.full_name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                return (
                  <div
                    key={c.id} onClick={() => { sessionStorage.setItem('kid_open_client_id', c.id); go('clients'); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid #E2E8F0', cursor: 'pointer', background: '#fff', transition: 'transform .15s ease, box-shadow .15s ease, border-color .15s ease' }}
                    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(15,23,42,.08)'; e.currentTarget.style.borderColor = '#BAE6FD'; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = '#E2E8F0'; }}
                  >
                    {c.photo_url ? (
                      <img src={c.photo_url} alt={c.full_name} style={{ width: 38, height: 38, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: 38, height: 38, borderRadius: 9, background: 'linear-gradient(135deg,#0EA5E9,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 700, color: '#fff', flexShrink: 0 }}>{initials}</div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.full_name}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8' }}>{c.client_code}{age != null ? ` · ${age} yrs` : ''}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: '24px 0', textAlign: 'center', color: '#94A3B8', fontSize: 12.5 }}>No patients with session history assigned to you yet.</div>
          )}
        </div>
      )}

      {/* ANALYTICS SECTION */}
      <div id="analytics">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 18px' }}>
          {showMilestones && <button className={'ana-tab' + (anaTab === 'milestones' ? ' active' : '')} onClick={() => setAnaTab('milestones')}><i className="fa-solid fa-trophy" style={{ marginRight: 6 }}></i>Milestone Trends</button>}
          {!lockedDiscipline && <button className={'ana-tab' + (anaTab === 'booking' ? ' active' : '')} onClick={() => setAnaTab('booking')}><i className="fa-solid fa-calendar-check" style={{ marginRight: 6 }}></i>Booking Operations</button>}
          {!lockedDiscipline && <button className={'ana-tab' + (anaTab === 'employees' ? ' active' : '')} onClick={() => setAnaTab('employees')}><i className="fa-solid fa-stethoscope" style={{ marginRight: 6 }}></i>Therapist Statistics</button>}
          {!lockedDiscipline && <button className={'ana-tab' + (anaTab === 'demographics' ? ' active' : '')} onClick={() => setAnaTab('demographics')}><i className="fa-solid fa-chart-pie" style={{ marginRight: 6 }}></i>Demographics</button>}
        </div>

        {loadErr && (
          <div style={{ padding: '14px 18px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', marginBottom: 18, fontSize: 13, color: '#991B1B' }}>
            <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 8 }} />Couldn't load analytics data. Try refreshing the page.
          </div>
        )}

        {/* MILESTONE TRENDS TAB */}
        <div id="tab-milestones" style={{ display: anaTab === 'milestones' ? '' : 'none' }}>
          {/* Caseload Trend Distribution, separated by discipline. Therapist accounts
             (lockedDiscipline set) don't get this section at all, it's a caseload-wide
             view across many clients, not something scoped to their own one discipline
             adds much over the individual Goal Scale Trend chart right below it.
             Each client's own last-two-session T-score delta decides their bucket, so an
             improving half and a declining half of the caseload show up as two visible
             groups instead of cancelling out into one flat "no change" average. */}
          {!lockedDiscipline && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 22 }}>
            <div className="card" style={{ padding: '20px 22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 10 }}>
                <div><div className="section-title"><i className="fa-solid fa-hands" style={{ color: '#0EA5E9', marginRight: 7 }}></i>Caseload Trend: Occupational Therapy</div><div className="section-sub">{gasDistribution?.ot.total ? `${gasDistribution.ot.total} client${gasDistribution.ot.total === 1 ? '' : 's'} with a trend` : ''}</div></div>
              </div>
              {gasDistribution && gasDistribution.ot.total > 0 ? (
                <TrendDistributionBar dist={gasDistribution.ot} />
              ) : (
                <EmptyGasState icon="fa-chart-line" text="No data yet, submit OT GAS entries" />
              )}
            </div>
            <div className="card" style={{ padding: '20px 22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 10 }}>
                <div><div className="section-title"><i className="fa-solid fa-comments" style={{ color: '#F59E0B', marginRight: 7 }}></i>Caseload Trend: Speech-Language Therapy</div><div className="section-sub">{gasDistribution?.speech.total ? `${gasDistribution.speech.total} client${gasDistribution.speech.total === 1 ? '' : 's'} with a trend` : ''}</div></div>
              </div>
              {gasDistribution && gasDistribution.speech.total > 0 ? (
                <TrendDistributionBar dist={gasDistribution.speech} />
              ) : (
                <EmptyGasState icon="fa-chart-line" text="No data yet, submit Speech GAS entries" />
              )}
            </div>
          </div>
          )}

          {/* GAS Individual Goal Scale Trends, same locked-to-one-card treatment */}
          <div style={{ display: 'grid', gridTemplateColumns: lockedDiscipline ? '1fr' : 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 22 }}>
            {(!lockedDiscipline || lockedDiscipline === 'Occupational Therapy') && (
            <div className="card" style={{ padding: '20px 22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 10 }}>
                <div><div className="section-title"><i className="fa-solid fa-hands" style={{ color: '#0EA5E9', marginRight: 7 }}></i>Goal Scale Trend: Occupational Therapy</div><div className="section-sub">Goal level, −2 to +2</div></div>
              </div>
              {gasTrend && gasTrend.ot.goalSeries.length > 0 ? (
                <>
                  <TrendChart labels={gasTrend.ot.goalLabels} series={gasTrend.ot.goalSeries.map(g => ({ name: g.name, values: g.values, xIndices: g.xIndices, color: g.color }))} height={180} min={-2} max={2} refLine={0} />
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, paddingTop: 8, borderTop: '1px solid #F1F5F9' }}>
                    {gasTrend.ot.goalSeries.map(g => (
                      <span key={g.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#475569', fontWeight: 600 }}><span style={{ width: 12, height: 3, background: g.color, display: 'inline-block', borderRadius: 3 }}></span>{g.name.length > 25 ? g.name.slice(0, 23) + '\u2026' : g.name}</span>
                    ))}
                  </div>
                </>
              ) : (
                <EmptyGasState icon="fa-bullseye" text="No data yet, submit OT GAS entries to see individual goal trends" />
              )}
            </div>
            )}
            {(!lockedDiscipline || lockedDiscipline === 'Speech-Language Therapy') && (
            <div className="card" style={{ padding: '20px 22px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 10 }}>
                <div><div className="section-title"><i className="fa-solid fa-comments" style={{ color: '#F59E0B', marginRight: 7 }}></i>Goal Scale Trend: Speech-Language Therapy</div><div className="section-sub">Goal level, −2 to +2</div></div>
              </div>
              {gasTrend && gasTrend.speech.goalSeries.length > 0 ? (
                <>
                  <TrendChart labels={gasTrend.speech.goalLabels} series={gasTrend.speech.goalSeries.map(g => ({ name: g.name, values: g.values, xIndices: g.xIndices, color: g.color }))} height={180} min={-2} max={2} refLine={0} />
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, paddingTop: 8, borderTop: '1px solid #F1F5F9' }}>
                    {gasTrend.speech.goalSeries.map(g => (
                      <span key={g.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#475569', fontWeight: 600 }}><span style={{ width: 12, height: 3, background: g.color, display: 'inline-block', borderRadius: 3 }}></span>{g.name.length > 25 ? g.name.slice(0, 23) + '\u2026' : g.name}</span>
                    ))}
                  </div>
                </>
              ) : (
                <EmptyGasState icon="fa-bullseye" text="No data yet, submit Speech GAS entries to see individual goal trends" />
              )}
            </div>
            )}
          </div>
        </div>{/* end tab-milestones */}

        {/* BOOKING OPERATIONS TAB */}
        <div id="tab-booking" style={{ display: anaTab === 'booking' ? '' : 'none' }}>
          {/* Booking Trends: bookings per week/month/year, filterable by status */}
          <div className="card" style={{ padding: '20px 22px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4, gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div className="section-title"><i className="fa-solid fa-calendar-check" style={{ color: '#0EA5E9', marginRight: 7 }} />Booking Trends</div>
                <div className="section-sub">Number of bookings over time, clinic-wide</div>
              </div>
              <SegmentedToggle value={bookingPeriod} onChange={setBookingPeriod} options={[
                { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }
              ]} />
            </div>
            <div style={{ marginBottom: 6 }}>
              <SegmentedToggle value={bookingStatus} onChange={setBookingStatus} options={BOOKING_STATUS_OPTIONS} />
            </div>
            {bookings && bookings.length ? (() => {
              const trend = buildBookingTrend(bookings, bookingPeriod, bookingStatus);
              const totalShown = trend.values.reduce((s, v) => s + v, 0);
              const color = BOOKING_STATUS_COLOR[bookingStatus];
              return trend.values.some(v => v > 0) ? (
                <>
                  <TrendChart labels={trend.labels} series={[{ values: trend.values, color, area: true }]} height={190} min={0} max={trend.max} />
                  <div style={{ marginTop: 4, fontSize: 11.5, color: '#94A3B8', textAlign: 'right' }}>
                    {totalShown} {BOOKING_STATUS_OPTIONS.find(o => o.value === bookingStatus)?.label.toLowerCase()} booking{totalShown === 1 ? '' : 's'} · {{ weekly: 'last 12 weeks', monthly: 'last 6 months', yearly: 'last 6 years' }[bookingPeriod]}
                  </div>
                </>
              ) : (
                <div style={{ padding: '32px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No {bookingStatus === 'all' ? '' : BOOKING_STATUS_OPTIONS.find(o => o.value === bookingStatus)?.label.toLowerCase() + ' '}bookings in this range</div>
              );
            })() : (
              <div style={{ padding: '32px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>{bookings ? 'No bookings recorded yet' : 'Loading…'}</div>
            )}
          </div>
        </div>{/* end tab-booking */}

        {/* EMPLOYEE STATISTICS TAB */}
        <div id="tab-employees" style={{ display: anaTab === 'employees' ? '' : 'none' }}>
          {/* 7.2.b specialty mix and total therapists as one pie graph */}
          <div style={{ marginBottom: 20 }}>
            <div className="card" style={{ padding: '22px 24px' }}>
              <div className="section-title" style={{ marginBottom: 4 }}>Team Composition</div>
              <div className="section-sub" style={{ marginBottom: 18 }}>OT only · Speech only</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', gap: 24 }}>
                <div></div>
                <PieChart size={150} centerValue={employees?.total ?? 0} centerLabel="Therapists" segments={[
                  { value: employees?.specialtyCounts?.OT || 0, color: 'var(--cat-3)' },
                  { value: employees?.specialtyCounts?.Speech || 0, color: 'var(--cat-6)' },
                  { value: employees?.specialtyCounts?.Unassigned || 0, color: '#CBD5E1' }
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-3)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>OT Only</div><div style={{ fontSize: 12, color: '#64748B' }}>{employees?.specialtyCounts?.OT || 0}</div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-6)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Speech Only</div><div style={{ fontSize: 12, color: '#64748B' }}>{employees?.specialtyCounts?.Speech || 0}</div></div></div>
                  {employees?.specialtyCounts?.Unassigned > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#CBD5E1' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>No Sessions Yet</div><div style={{ fontSize: 12, color: '#64748B' }}>{employees.specialtyCounts.Unassigned}</div></div></div>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #F1F5F9' }}>
                <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Total therapists</span><span style={{ fontWeight: 700, color: '#0F172A' }}>{employees?.total ?? '-'}</span></div>
                <div className="status-row" style={{ borderBottom: 'none' }}><span style={{ fontSize: 13, color: '#475569' }}>Avg clients per therapist</span><span style={{ fontWeight: 700, color: '#0F172A' }}>{employees?.total ? (empRows.reduce((s, r) => s + r.clients, 0) / employees.total).toFixed(1) : '-'}</span></div>
              </div>
            </div>
          </div>

          {/* Caseload distribution: plain per-therapist client counts, sorted,
             no over/under-booked judgment call, just "how many" at a glance. */}
          <div style={{ marginBottom: 20 }}>
            <div className="card" style={{ padding: '22px 24px' }}>
              <div className="section-title" style={{ marginBottom: 4 }}>Caseload Distribution</div>
              <div className="section-sub" style={{ marginBottom: 18 }}>Active clients per therapist</div>
              {empRows.length ? (() => {
                const rows = [...empRows].sort((a, b) => b.clients - a.clients);
                const totalClients = rows.reduce((s, r) => s + r.clients, 0);
                const CASELOAD_COLORS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)', 'var(--cat-7)', 'var(--cat-8)'];
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', gap: 24 }}>
                    <div></div>
                    <PieChart size={150} centerValue={totalClients} centerLabel="Active Clients" segments={rows.map((r, i) => ({ value: r.clients, color: CASELOAD_COLORS[i % CASELOAD_COLORS.length] }))} />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                      {rows.map((r, i) => (
                        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="legend-dot" style={{ background: CASELOAD_COLORS[i % CASELOAD_COLORS.length] }}></div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{r.name}<span style={{ fontSize: 11, fontWeight: 500, color: '#94A3B8', marginLeft: 6 }}>{r.specialty}</span></div>
                            <div style={{ fontSize: 12, color: '#64748B' }}>{r.clients}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })() : (
                <div style={{ padding: '32px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No therapist data yet</div>
              )}
            </div>
          </div>
        </div>{/* end tab-employees */}

        {/* DEMOGRAPHICS TAB */}
        <div id="tab-demographics" style={{ display: anaTab === 'demographics' ? '' : 'none' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 22 }}>
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-venus-mars" style={{ color: '#818CF8', marginRight: 7 }}></i>Gender Distribution</div>
              <div className="section-sub" style={{ marginBottom: 20 }}>Client gender breakdown across all programs</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 28, justifyContent: 'center', flexWrap: 'wrap' }}>
                <PieChart size={150} centerValue={genderTotal} centerLabel="Total" segments={[
                  { value: demo?.gender?.Male || 0, color: 'var(--cat-1)' },
                  { value: demo?.gender?.Female || 0, color: 'var(--cat-4)' },
                  { value: demo?.gender?.Unspecified || 0, color: '#CBD5E1' }
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-1)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Male</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.gender?.Male || 0} · <strong style={{ color: 'var(--cat-1)' }}>{genderTotal ? Math.round(((demo?.gender?.Male || 0) / genderTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-4)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Female</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.gender?.Female || 0} · <strong style={{ color: 'var(--cat-4)' }}>{genderTotal ? Math.round(((demo?.gender?.Female || 0) / genderTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#CBD5E1' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Not Specified</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.gender?.Unspecified || 0} · <strong style={{ color: '#64748B' }}>{genderTotal ? Math.round(((demo?.gender?.Unspecified || 0) / genderTotal) * 100) : 0}%</strong></div></div></div>
                </div>
              </div>
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #F1F5F9' }}>
                <div className="status-row" style={{ borderBottom: 'none' }}><span style={{ fontSize: 13, color: '#475569' }}>Male-to-female ratio</span><span className="pill pill-blue" style={{ fontSize: 10 }}>{demo?.gender?.Female ? (demo.gender.Male / demo.gender.Female).toFixed(2) : '-'} : 1</span></div>
              </div>
            </div>
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-cake-candles" style={{ color: '#F59E0B', marginRight: 7 }}></i>Age Distribution</div>
              <div className="section-sub" style={{ marginBottom: 20 }}>Client age group breakdown across all programs</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 28, justifyContent: 'center', flexWrap: 'wrap' }}>
                <PieChart size={150} centerValue={ageTotal} centerLabel="Total" segments={[
                  { value: demo?.ageBrackets?.['3-4'] || 0, color: 'var(--cat-1)' },
                  { value: demo?.ageBrackets?.['5-6'] || 0, color: 'var(--cat-2)' },
                  { value: demo?.ageBrackets?.['7-8'] || 0, color: 'var(--cat-3)' },
                  { value: demo?.ageBrackets?.['9+'] || 0, color: 'var(--cat-4)' }
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-1)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 3–4</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['3-4'] || 0} · <strong style={{ color: 'var(--cat-1)' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['3-4'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-2)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 5–6</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['5-6'] || 0} · <strong style={{ color: 'var(--cat-2)' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['5-6'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-3)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 7–8</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['7-8'] || 0} · <strong style={{ color: 'var(--cat-3)' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['7-8'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: 'var(--cat-4)' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 9+</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['9+'] || 0} · <strong style={{ color: 'var(--cat-4)' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['9+'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
                </div>
              </div>
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #F1F5F9' }}>
                <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Peak enrollment age</span><span className="pill pill-green" style={{ fontSize: 10 }}>{peakAgeBracket ? `${peakAgeBracket[0]} years (${ageTotal ? Math.round((peakAgeBracket[1] / ageTotal) * 100) : 0}%)` : '-'}</span></div>
                <div className="status-row" style={{ borderBottom: 'none' }}><span style={{ fontSize: 13, color: '#475569' }}>Youngest / Oldest</span><span style={{ fontWeight: 600, color: '#0F172A' }}>{demo?.youngest != null ? demo.youngest + ' yrs' : '-'} / {demo?.oldest != null ? demo.oldest + ' yrs' : '-'}</span></div>
              </div>
            </div>
          </div>
        </div>{/* end tab-demographics */}

      </div>{/* end #analytics */}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · All rights reserved</span></div>
    </div>
  );
}

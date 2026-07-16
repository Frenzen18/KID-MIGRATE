import { useState, useEffect } from 'react';
import { api } from '../../../api.js';

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

/** Euclidean length of a polyline given its [x,y] points, used to drive the line "draw-in" animation. */
function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    len += Math.hypot(x2 - x1, y2 - y1);
  }
  return len;
}

/** Multi-series line/area chart. `series`: [{ values, color, dashed? }], values aligned to `labels`. */
export function TrendChart({ labels, series, height = 170 }) {
  const width = 560, padTop = 18, padBottom = 24;
  const allVals = series.flatMap(s => s.values).filter(v => v != null);
  // Lines draw themselves in left-to-right on mount, like a live readout arriving,   // a chart that just snaps into place reads as a static image, not real data.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    setDrawn(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, [labels.join(','), series.map(s => s.values.join(',')).join('|')]);
  if (!allVals.length) {
    return <div style={{ padding: '48px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No data yet</div>;
  }
  const max = Math.max(...allVals, 10);
  const min = Math.min(0, ...allVals);
  const span = Math.max(1, max - min);
  const usableH = height - padTop - padBottom;
  const n = labels.length;
  const stepX = n > 1 ? width / (n - 1) : 0;
  const toXY = (v, i) => [Math.round(i * stepX), Math.round(padTop + usableH - ((v - min) / span) * usableH)];

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <line x1="0" y1={padTop} x2={width} y2={padTop} stroke="#F1F5F9" />
      <line x1="0" y1={padTop + usableH / 2} x2={width} y2={padTop + usableH / 2} stroke="#F1F5F9" />
      <line x1="0" y1={padTop + usableH} x2={width} y2={padTop + usableH} stroke="#F1F5F9" />
      {series.map((s, si) => {
        const pts = s.values.map((v, i) => (v == null ? null : toXY(v, i))).filter(Boolean);
        if (!pts.length) return null;
        const points = pts.map(([x, y]) => `${x},${y}`).join(' ');
        const len = polylineLength(pts) + 4;
        return (
          <g key={si}>
            <polyline points={points} fill="none" stroke={s.color} strokeWidth={s.dashed ? 2.5 : 3}
              strokeDasharray={s.dashed ? '7,4' : `${len} ${len}`}
              strokeDashoffset={s.dashed ? undefined : (drawn ? 0 : len)}
              className={s.dashed ? undefined : 'trend-line-draw'}
              strokeLinecap="round" strokeLinejoin="round" />
            {!s.dashed && pts.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={i === pts.length - 1 ? 5 : 4} fill={s.color} stroke="#fff"
                strokeWidth={i === pts.length - 1 ? 2.5 : 2}
                className="trend-point-in" style={{ animationDelay: (0.15 + i * 0.05) + 's' }} />
            ))}
          </g>
        );
      })}
      {labels.map((l, i) => (
        <text key={l + i} x={i * stepX} y={height - 6} fontSize="10" fill="#94A3B8" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{l}</text>
      ))}
    </svg>
  );
}

const ROLE_DISCIPLINE = { ot: 'Occupational Therapy', speech: 'Speech-Language Therapy' };

export default function Dashboard({ go, toast, openModal, role = 'admin' }) {
  // An 'ot'/'speech' therapist only sees their own discipline's Milestone Trends,   // Employee Statistics and Demographics are clinic-wide admin/staff concerns.
  // Staff doesn't get Milestone Trends at all (front-desk/billing role, not clinical).
  const lockedDiscipline = ROLE_DISCIPLINE[role] || null;
  const showMilestones = role !== 'staff';
  const [anaTab, setAnaTab] = useState(showMilestones ? 'milestones' : 'employees');

  const [employees, setEmployees] = useState(null);
  const [demo, setDemo] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [gasTrend, setGasTrend] = useState(null); // { months, ot, speech }

  useEffect(() => {
    if (!lockedDiscipline) {
      Promise.all([
        api('/analytics/employees'),
        api('/analytics/demographics')
      ]).then(([e, d]) => {
        setEmployees(e); setDemo(d);
      }).catch(() => { setLoadErr(true); toast('Failed to load dashboard analytics', 'fa-triangle-exclamation'); });
    }

    if (!showMilestones) return;

    // GAS entries fetched separately so a failure doesn't block the rest of the dashboard
    api('/gas/entries' + (lockedDiscipline ? '?discipline=' + encodeURIComponent(lockedDiscipline) : '')).then(gasEntries => {
      if (!gasEntries || !gasEntries.length) return;
      const buckets = {}; // { 'YYYY-MM': { ot: [scores], speech: [scores] } }
      const goalBuckets = { 'Occupational Therapy': {}, 'Speech-Language Therapy': {} };

      for (const entry of gasEntries) {
        const month = entry.session_date?.slice(0, 7);
        if (!month) continue;

        if (entry.gas_t_score != null) {
          if (!buckets[month]) buckets[month] = { ot: [], speech: [] };
          if (entry.discipline === 'Occupational Therapy') buckets[month].ot.push(entry.gas_t_score);
          else if (entry.discipline === 'Speech-Language Therapy') buckets[month].speech.push(entry.gas_t_score);
        }

        const disc = entry.discipline;
        if (goalBuckets[disc] && Array.isArray(entry.scores)) {
          for (const sc of entry.scores) {
            const title = sc.item_title || 'Unknown Goal';
            if (sc.level == null) continue;
            if (!goalBuckets[disc][title]) goalBuckets[disc][title] = {};
            if (!goalBuckets[disc][title][month]) goalBuckets[disc][title][month] = [];
            goalBuckets[disc][title][month].push(sc.level);
          }
        }
      }

      const months = Object.keys(buckets).sort().slice(-6);
      if (!months.length) return;
      const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 10) / 10 : null;
      const monthLabels = months.map(m => { const [, mo] = m.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo) - 1]; });

      const GOAL_COLORS = ['#0EA5E9', '#F59E0B', '#818CF8', '#10B981', '#EC4899', '#EF4444', '#14B8A6', '#A855F7'];
      function buildGoalSeries(disc) {
        const goals = goalBuckets[disc];
        const names = Object.keys(goals);
        return names.map((name, i) => ({
          name,
          color: GOAL_COLORS[i % GOAL_COLORS.length],
          values: months.map(m => avg(goals[name][m] || []))
        }));
      }

      setGasTrend({
        months: monthLabels,
        rawMonths: months,
        ot: months.map(m => avg(buckets[m]?.ot || [])),
        speech: months.map(m => avg(buckets[m]?.speech || [])),
        otCount: months.reduce((s, m) => s + (buckets[m]?.ot?.length || 0), 0),
        speechCount: months.reduce((s, m) => s + (buckets[m]?.speech?.length || 0), 0),
        otGoals: buildGoalSeries('Occupational Therapy'),
        speechGoals: buildGoalSeries('Speech-Language Therapy'),
      });
    }).catch(() => { /* GAS trend is optional, don't block dashboard */ });
  }, []);

  const empRows = employees?.rows || [];

  const genderTotal = demo ? demo.gender.Male + demo.gender.Female + demo.gender.Unspecified : 0;
  const ageTotal = demo ? Object.values(demo.ageBrackets).reduce((s, v) => s + v, 0) : 0;
  const peakAgeBracket = demo ? Object.entries(demo.ageBrackets).sort((a, b) => b[1] - a[1])[0] : null;

  return (
    <div className="spa-page" id="spa-dashboard">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Good morning, Dr. Reyes 👋</h1>
        <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}><i className="fa-regular fa-calendar" style={{ marginRight: 5 }}></i>{new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>

      {/* ANALYTICS SECTION */}
      <div id="analytics">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 18px' }}>
          {showMilestones && <button className={'ana-tab' + (anaTab === 'milestones' ? ' active' : '')} onClick={() => setAnaTab('milestones')}><i className="fa-solid fa-trophy" style={{ marginRight: 6 }}></i>Milestone Trends</button>}
          {!lockedDiscipline && <button className={'ana-tab' + (anaTab === 'employees' ? ' active' : '')} onClick={() => setAnaTab('employees')}><i className="fa-solid fa-stethoscope" style={{ marginRight: 6 }}></i>Employee Statistics</button>}
          {!lockedDiscipline && <button className={'ana-tab' + (anaTab === 'demographics' ? ' active' : '')} onClick={() => setAnaTab('demographics')}><i className="fa-solid fa-chart-pie" style={{ marginRight: 6 }}></i>Demographics</button>}
        </div>

        {loadErr && (
          <div style={{ padding: '14px 18px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', marginBottom: 18, fontSize: 13, color: '#991B1B' }}>
            <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: 8 }} />Couldn't load analytics data. Try refreshing the page.
          </div>
        )}

        {/* MILESTONE TRENDS TAB */}
        <div id="tab-milestones" style={{ display: anaTab === 'milestones' ? '' : 'none' }}>
          {/* GAS T-Score Trend, separated by discipline; locked accounts only see their own card */}
          <div style={{ display: 'grid', gridTemplateColumns: lockedDiscipline ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 22 }}>
            {/* Occupational Therapy */}
            {(!lockedDiscipline || lockedDiscipline === 'Occupational Therapy') && (
            <div className="card" style={{ padding: '22px 24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div><div className="section-title"><i className="fa-solid fa-hands" style={{ color: '#0EA5E9', marginRight: 7 }}></i>GAS T-Score: Occupational Therapy</div><div className="section-sub">Average T-Score per month from GAS assessments{gasTrend ? ` (${gasTrend.otCount} entries)` : ''}</div></div>
                <span className="pill pill-blue">OT</span>
              </div>
              {gasTrend && gasTrend.otCount > 0 ? (
                <>
                  <TrendChart labels={gasTrend.months} series={[{ values: gasTrend.ot, color: '#0EA5E9' }]} height={160} />
                  <div style={{ display: 'flex', gap: 20, marginTop: 10, paddingTop: 8, borderTop: '1px solid #F1F5F9' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#475569' }}><span style={{ width: 20, height: 3, background: '#0EA5E9', display: 'inline-block', borderRadius: 4 }}></span>Avg GAS T-Score</div>
                    <div style={{ fontSize: 12, color: '#94A3B8' }}>T=50 = expected outcome</div>
                  </div>
                </>
              ) : (
                <div style={{ padding: '48px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-chart-line" style={{ marginRight: 6, opacity: 0.5 }} />No data yet, submit OT GAS entries</div>
              )}
            </div>
            )}
            {/* Speech-Language Therapy */}
            {(!lockedDiscipline || lockedDiscipline === 'Speech-Language Therapy') && (
            <div className="card" style={{ padding: '22px 24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div><div className="section-title"><i className="fa-solid fa-comments" style={{ color: '#F59E0B', marginRight: 7 }}></i>GAS T-Score: Speech-Language Therapy</div><div className="section-sub">Average T-Score per month from GAS assessments{gasTrend ? ` (${gasTrend.speechCount} entries)` : ''}</div></div>
                <span className="pill pill-amber">Speech</span>
              </div>
              {gasTrend && gasTrend.speechCount > 0 ? (
                <>
                  <TrendChart labels={gasTrend.months} series={[{ values: gasTrend.speech, color: '#F59E0B' }]} height={160} />
                  <div style={{ display: 'flex', gap: 20, marginTop: 10, paddingTop: 8, borderTop: '1px solid #F1F5F9' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#475569' }}><span style={{ width: 20, height: 3, background: '#F59E0B', display: 'inline-block', borderRadius: 4 }}></span>Avg GAS T-Score</div>
                    <div style={{ fontSize: 12, color: '#94A3B8' }}>T=50 = expected outcome</div>
                  </div>
                </>
              ) : (
                <div style={{ padding: '48px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-chart-line" style={{ marginRight: 6, opacity: 0.5 }} />No data yet, submit Speech GAS entries</div>
              )}
            </div>
            )}
          </div>

          {/* GAS Individual Goal Scale Trends, same locked-to-one-card treatment */}
          <div style={{ display: 'grid', gridTemplateColumns: lockedDiscipline ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 22 }}>
            {(!lockedDiscipline || lockedDiscipline === 'Occupational Therapy') && (
            <div className="card" style={{ padding: '22px 24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div><div className="section-title"><i className="fa-solid fa-hands" style={{ color: '#0EA5E9', marginRight: 7 }}></i>Goal Scale Trend: Occupational Therapy</div><div className="section-sub">Average goal attainment level (−2 to +2) per goal item across all OT sessions</div></div>
                <span className="pill pill-blue">OT Goals</span>
              </div>
              {gasTrend && gasTrend.otGoals.length > 0 ? (
                <>
                  <TrendChart labels={gasTrend.months} series={gasTrend.otGoals.map(g => ({ values: g.values, color: g.color }))} height={180} />
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, paddingTop: 8, borderTop: '1px solid #F1F5F9' }}>
                    {gasTrend.otGoals.map(g => (
                      <span key={g.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#475569', fontWeight: 600 }}><span style={{ width: 12, height: 3, background: g.color, display: 'inline-block', borderRadius: 3 }}></span>{g.name.length > 25 ? g.name.slice(0, 23) + '\u2026' : g.name}</span>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ padding: '48px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-bullseye" style={{ marginRight: 6, opacity: 0.5 }} />No data yet, submit OT GAS entries to see individual goal trends</div>
              )}
            </div>
            )}
            {(!lockedDiscipline || lockedDiscipline === 'Speech-Language Therapy') && (
            <div className="card" style={{ padding: '22px 24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div><div className="section-title"><i className="fa-solid fa-comments" style={{ color: '#F59E0B', marginRight: 7 }}></i>Goal Scale Trend: Speech-Language Therapy</div><div className="section-sub">Average goal attainment level (−2 to +2) per goal item across all Speech sessions</div></div>
                <span className="pill pill-amber">Speech Goals</span>
              </div>
              {gasTrend && gasTrend.speechGoals.length > 0 ? (
                <>
                  <TrendChart labels={gasTrend.months} series={gasTrend.speechGoals.map(g => ({ values: g.values, color: g.color }))} height={180} />
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, paddingTop: 8, borderTop: '1px solid #F1F5F9' }}>
                    {gasTrend.speechGoals.map(g => (
                      <span key={g.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#475569', fontWeight: 600 }}><span style={{ width: 12, height: 3, background: g.color, display: 'inline-block', borderRadius: 3 }}></span>{g.name.length > 25 ? g.name.slice(0, 23) + '\u2026' : g.name}</span>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ padding: '48px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-bullseye" style={{ marginRight: 6, opacity: 0.5 }} />No data yet, submit Speech GAS entries to see individual goal trends</div>
              )}
            </div>
            )}
          </div>
        </div>{/* end tab-milestones */}

        {/* EMPLOYEE STATISTICS TAB */}
        <div id="tab-employees" style={{ display: anaTab === 'employees' ? '' : 'none' }}>
          {/* 7.2.b specialty mix, total therapists, OT/Speech/Both, and team sessions as one pie graph */}
          <div style={{ marginBottom: 20 }}>
            <div className="card" style={{ padding: '22px 24px' }}>
              <div className="section-title" style={{ marginBottom: 4 }}>Team Composition</div>
              <div className="section-sub" style={{ marginBottom: 18 }}>OT only · Speech only · handles both</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
                <PieChart size={150} centerValue={employees?.total ?? 0} centerLabel="Therapists" segments={[
                  { value: employees?.specialtyCounts?.OT || 0, color: '#0EA5E9' },
                  { value: employees?.specialtyCounts?.Speech || 0, color: '#0D9488' },
                  { value: employees?.specialtyCounts?.Both || 0, color: '#F59E0B' },
                  { value: employees?.specialtyCounts?.Unassigned || 0, color: '#CBD5E1' }
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#0EA5E9' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>OT Only</div><div style={{ fontSize: 12, color: '#64748B' }}>{employees?.specialtyCounts?.OT || 0}</div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#0D9488' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Speech Only</div><div style={{ fontSize: 12, color: '#64748B' }}>{employees?.specialtyCounts?.Speech || 0}</div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#F59E0B' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Both (OT + Speech)</div><div style={{ fontSize: 12, color: '#64748B' }}>{employees?.specialtyCounts?.Both || 0}</div></div></div>
                  {employees?.specialtyCounts?.Unassigned > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#CBD5E1' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>No Sessions Yet</div><div style={{ fontSize: 12, color: '#64748B' }}>{employees.specialtyCounts.Unassigned}</div></div></div>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #F1F5F9' }}>
                <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Total therapists</span><span style={{ fontWeight: 700, color: '#0F172A' }}>{employees?.total ?? '-'}</span></div>
                <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Team sessions (YTD)</span><span style={{ fontWeight: 700, color: '#0F172A' }}>{employees?.teamSessionsTotal ?? '-'}</span></div>
                <div className="status-row" style={{ borderBottom: 'none' }}><span style={{ fontSize: 13, color: '#475569' }}>Avg clients per therapist</span><span style={{ fontWeight: 700, color: '#0F172A' }}>{employees?.total ? (empRows.reduce((s, r) => s + r.clients, 0) / employees.total).toFixed(1) : '-'}</span></div>
              </div>
            </div>
          </div>
        </div>{/* end tab-employees */}

        {/* DEMOGRAPHICS TAB */}
        <div id="tab-demographics" style={{ display: anaTab === 'demographics' ? '' : 'none' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 22 }}>
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-venus-mars" style={{ color: '#818CF8', marginRight: 7 }}></i>Gender Distribution</div>
              <div className="section-sub" style={{ marginBottom: 20 }}>Client gender breakdown across all programs</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 28, justifyContent: 'center', flexWrap: 'wrap' }}>
                <PieChart size={150} centerValue={genderTotal} centerLabel="Total" segments={[
                  { value: demo?.gender?.Male || 0, color: '#0EA5E9' },
                  { value: demo?.gender?.Female || 0, color: '#EC4899' },
                  { value: demo?.gender?.Unspecified || 0, color: '#CBD5E1' }
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#0EA5E9' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Male</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.gender?.Male || 0} · <strong style={{ color: '#0EA5E9' }}>{genderTotal ? Math.round(((demo?.gender?.Male || 0) / genderTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#EC4899' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Female</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.gender?.Female || 0} · <strong style={{ color: '#EC4899' }}>{genderTotal ? Math.round(((demo?.gender?.Female || 0) / genderTotal) * 100) : 0}%</strong></div></div></div>
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
                  { value: demo?.ageBrackets?.['3-4'] || 0, color: '#0EA5E9' },
                  { value: demo?.ageBrackets?.['5-6'] || 0, color: '#10B981' },
                  { value: demo?.ageBrackets?.['7-8'] || 0, color: '#818CF8' },
                  { value: demo?.ageBrackets?.['9+'] || 0, color: '#F59E0B' }
                ]} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#0EA5E9' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 3–4</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['3-4'] || 0} · <strong style={{ color: '#0EA5E9' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['3-4'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#10B981' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 5–6</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['5-6'] || 0} · <strong style={{ color: '#10B981' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['5-6'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#818CF8' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 7–8</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['7-8'] || 0} · <strong style={{ color: '#818CF8' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['7-8'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="legend-dot" style={{ background: '#F59E0B' }}></div><div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Ages 9+</div><div style={{ fontSize: 12, color: '#64748B' }}>{demo?.ageBrackets?.['9+'] || 0} · <strong style={{ color: '#F59E0B' }}>{ageTotal ? Math.round(((demo?.ageBrackets?.['9+'] || 0) / ageTotal) * 100) : 0}%</strong></div></div></div>
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

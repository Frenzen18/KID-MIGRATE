import { useMemo, useState } from 'react';

/**
 * Longitudinal Progress Trend Graph for GAS (Goal Attainment Scaling).
 *
 * Separates charts by discipline (Occupational Therapy / Speech-Language Therapy).
 * Each discipline section renders:
 * 1. Individual Goal Scale line graph (Y: -2 to +2)
 * 2. GAS T-Score trend (Y: T-score)
 *
 * Hover tooltips show therapist remarks, date, and score details.
 *
 * Props:
 *   entries: Array of GAS entry objects from GET /api/gas/entries?client_id=X
 */

const GOAL_COLORS = ['#0EA5E9', '#F59E0B', '#818CF8', '#10B981', '#EC4899', '#EF4444', '#14B8A6', '#A855F7'];

const DISCIPLINE_META = {
  'Occupational Therapy': { icon: 'fa-hands', color: '#0EA5E9', gradient: ['#0EA5E9', '#0EA5E9'] },
  'Speech-Language Therapy': { icon: 'fa-comments', color: '#F59E0B', gradient: ['#F59E0B', '#F59E0B'] },
};

function gasScoreTone(score) {
  if (score == null) return '#94A3B8';
  if (score >= 60) return '#10B981';
  if (score >= 45) return '#0EA5E9';
  if (score >= 35) return '#F59E0B';
  return '#EF4444';
}

function monthLabel(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fullDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ── Sub-component: renders goal scales + T-score charts for ONE discipline ── */
function DisciplineChart({ discipline, entries }) {
  const [tip, setTip] = useState(null);
  const [tScoreTip, setTScoreTip] = useState(null);

  const meta = DISCIPLINE_META[discipline] || { icon: 'fa-clipboard', color: '#818CF8', gradient: ['#818CF8', '#818CF8'] };

  const sorted = useMemo(() =>
    [...entries].sort((a, b) => new Date(a.session_date) - new Date(b.session_date)),
    [entries]
  );

  // Goal scales model
  const goalModel = useMemo(() => {
    if (!sorted.length) return null;
    const goalMap = {};
    sorted.forEach((entry, idx) => {
      for (const s of entry.scores || []) {
        const title = s.item_title || 'Unknown Goal';
        if (!goalMap[title]) goalMap[title] = [];
        goalMap[title].push({ date: entry.session_date, level: s.level, entryIdx: idx, weight: s.weight });
      }
    });
    const goalNames = Object.keys(goalMap);
    if (!goalNames.length) return null;
    const uniqueDates = [...new Set(sorted.map(e => e.session_date))];
    const W = 640, H = 220, x0 = 40, x1 = 530, y0 = 190, y1 = 20;
    const xFor = d => uniqueDates.length === 1 ? (x0 + x1) / 2 : x0 + (uniqueDates.indexOf(d) / (uniqueDates.length - 1)) * (x1 - x0);
    const yFor = lvl => y0 - ((lvl + 2) / 4) * (y0 - y1);
    const series = goalNames.map((name, i) => ({
      name,
      color: GOAL_COLORS[i % GOAL_COLORS.length],
      pts: goalMap[name].map(p => ({ ...p, x: xFor(p.date), y: yFor(p.level), entry: sorted[p.entryIdx] }))
    }));
    return { W, H, x0, x1, y0, y1, series, uniqueDates, xFor, yFor };
  }, [sorted]);

  // T-Score model
  const tScoreModel = useMemo(() => {
    const pts = sorted.filter(e => e.gas_t_score != null);
    if (!pts.length) return null;
    const uniqueDates = [...new Set(pts.map(e => e.session_date))];
    const scores = pts.map(e => e.gas_t_score);
    const minScore = Math.min(...scores, 30);
    const maxScore = Math.max(...scores, 70);
    const range = maxScore - minScore || 1;
    const padded = { min: minScore - range * 0.1, max: maxScore + range * 0.1 };
    const W = 640, H = 180, x0 = 40, x1 = 530, y0 = 155, y1 = 20;
    const xFor = d => uniqueDates.length === 1 ? (x0 + x1) / 2 : x0 + (uniqueDates.indexOf(d) / (uniqueDates.length - 1)) * (x1 - x0);
    const yFor = s => y0 - ((s - padded.min) / (padded.max - padded.min)) * (y0 - y1);
    const step = Math.max(5, Math.round(range / 4));
    const ticks = [];
    for (let v = Math.floor(minScore / step) * step; v <= maxScore + step; v += step) ticks.push(v);
    const points = pts.map(e => ({ x: xFor(e.session_date), y: yFor(e.gas_t_score), score: e.gas_t_score, date: e.session_date, entry: e }));
    return { W, H, x0, x1, y0, y1, points, uniqueDates, xFor, yFor, ticks, padded };
  }, [sorted]);

  if (!sorted.length) return null;

  return (
    <div style={{ marginBottom: 28, padding: '18px 20px', border: '1px solid #E2E8F0', borderRadius: 14, background: '#FAFBFC' }}>
      {/* Discipline header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <i className={'fa-solid ' + meta.icon} style={{ color: meta.color, fontSize: 16 }} />
        <span style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{discipline}</span>
        <span style={{ fontSize: 12, color: '#94A3B8', marginLeft: 4 }}>{sorted.length} session{sorted.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Goal Scales Chart */}
      {goalModel && goalModel.series.length > 0 && (
        <div className="cp-wrap" style={{ position: 'relative', marginBottom: 22 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#334155', marginBottom: 8 }}>
            <i className="fa-solid fa-bullseye" style={{ color: '#4F46E5', marginRight: 6 }} />
            Individual Goal Scales (−2 to +2)
          </div>
          <svg width="100%" height="240" viewBox={`0 0 ${goalModel.W} ${goalModel.H + 20}`} style={{ overflow: 'visible', display: 'block' }}>
            {[-2, -1, 0, 1, 2].map(lvl => {
              const y = goalModel.yFor(lvl);
              return (
                <g key={lvl}>
                  <line x1={goalModel.x0} y1={y} x2={goalModel.x1} y2={y} stroke={lvl === 0 ? '#CBD5E1' : '#F1F5F9'} strokeDasharray={lvl === 0 ? '4 2' : undefined} />
                  <text x={goalModel.x0 - 6} y={y + 3.5} fontSize="10" fill="#64748B" textAnchor="end" fontWeight={lvl === 0 ? '700' : '400'}>
                    {lvl > 0 ? '+' + lvl : lvl}
                  </text>
                </g>
              );
            })}
            {goalModel.uniqueDates.map(d => (
              <text key={d} x={goalModel.xFor(d)} y={goalModel.H + 14} fontSize="9.5" fill="#94A3B8" textAnchor="middle">{monthLabel(d)}</text>
            ))}
            {goalModel.series.map(s => (
              <polyline key={s.name} points={s.pts.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
            ))}
            {goalModel.series.map(s => s.pts.map((p, i) => (
              <g key={s.name + '-' + i}>
                <circle cx={p.x} cy={p.y} r="4.5" fill={s.color} stroke="#fff" strokeWidth="1.5" />
                <circle cx={p.x} cy={p.y} r="13" fill="transparent" style={{ cursor: 'pointer' }}
                  onMouseEnter={e => {
                    const wrap = e.currentTarget.closest('.cp-wrap').getBoundingClientRect();
                    const r = e.currentTarget.getBoundingClientRect();
                    setTip({
                      left: Math.max(130, Math.min(wrap.width - 130, r.left - wrap.left + r.width / 2)),
                      top: r.top - wrap.top,
                      goal: s.name, color: s.color,
                      level: p.level, weight: p.weight,
                      date: fullDate(p.date),
                      therapist: p.entry.therapist_name,
                      remarks: p.entry.remarks,
                      discipline: p.entry.discipline,
                      tScore: p.entry.gas_t_score
                    });
                  }}
                  onMouseLeave={() => setTip(null)} />
              </g>
            )))}
            {(() => {
              const ends = goalModel.series.map(s => ({ s, y: s.pts[s.pts.length - 1]?.y ?? 0 })).sort((a, b) => a.y - b.y);
              for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
              return ends.map(({ s, y }) => (
                <text key={s.name} x={goalModel.x1 + 8} y={y + 3} fontSize="9.5" fontWeight="600" fill="#475569">{s.name.length > 22 ? s.name.slice(0, 20) + '...' : s.name}</text>
              ));
            })()}
          </svg>

          {tip && (
            <div className="cp-tip" style={{ left: tip.left, top: tip.top }}>
              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, marginBottom: 2 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: tip.color, display: 'inline-block' }} />
                {tip.goal} · Level {tip.level > 0 ? '+' + tip.level : tip.level}
              </div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 6 }}>
                <i className="fa-regular fa-calendar" style={{ marginRight: 4 }} />
                {tip.date}{tip.therapist ? ' · ' + tip.therapist : ''}
              </div>
              <div style={{ fontSize: 10.5, color: '#94A3B8', marginBottom: 4 }}>
                T-Score: <b style={{ color: gasScoreTone(tip.tScore) }}>{tip.tScore}</b> · Weight: x{tip.weight}
              </div>
              {tip.remarks && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px', marginTop: 4, marginBottom: 2 }}>Therapist Remarks</div>
                  <div style={{ color: '#CBD5E1', fontSize: 11.5 }}>
                    <i className="fa-regular fa-note-sticky" style={{ marginRight: 4, opacity: .7 }} />
                    "{tip.remarks}"
                  </div>
                </>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
            {goalModel.series.map(s => (
              <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#475569', fontWeight: 600 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: 'inline-block' }} />{s.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* T-Score Trend Chart */}
      {tScoreModel && (
        <div className="cp-wrap" style={{ position: 'relative' }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#334155', marginBottom: 8 }}>
            <i className="fa-solid fa-chart-line" style={{ color: meta.color, marginRight: 6 }} />
            GAS T-Score Trend
          </div>
          <svg width="100%" height="200" viewBox={`0 0 ${tScoreModel.W} ${tScoreModel.H + 20}`} style={{ overflow: 'visible', display: 'block' }}>
            {tScoreModel.ticks.map(v => {
              const y = tScoreModel.yFor(v);
              if (y < tScoreModel.y1 - 10 || y > tScoreModel.y0 + 10) return null;
              return (
                <g key={v}>
                  <line x1={tScoreModel.x0} y1={y} x2={tScoreModel.x1} y2={y} stroke={v === 50 ? '#CBD5E1' : '#F1F5F9'} strokeDasharray={v === 50 ? '4 2' : undefined} />
                  <text x={tScoreModel.x0 - 6} y={y + 3.5} fontSize="10" fill="#64748B" textAnchor="end" fontWeight={v === 50 ? '700' : '400'}>{v}</text>
                </g>
              );
            })}
            <text x={tScoreModel.x1 + 6} y={tScoreModel.yFor(50) + 3} fontSize="9" fill="#94A3B8">Expected</text>
            {tScoreModel.uniqueDates.map(d => (
              <text key={d} x={tScoreModel.xFor(d)} y={tScoreModel.H + 14} fontSize="9.5" fill="#94A3B8" textAnchor="middle">{monthLabel(d)}</text>
            ))}
            {tScoreModel.points.length > 1 && (
              <polygon
                points={[
                  ...tScoreModel.points.map(p => `${p.x},${p.y}`),
                  `${tScoreModel.points[tScoreModel.points.length - 1].x},${tScoreModel.y0}`,
                  `${tScoreModel.points[0].x},${tScoreModel.y0}`
                ].join(' ')}
                fill={`url(#gasGrad-${discipline.replace(/\s/g, '')})`} opacity="0.25"
              />
            )}
            <defs>
              <linearGradient id={`gasGrad-${discipline.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={meta.color} stopOpacity="0.4" />
                <stop offset="100%" stopColor={meta.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <polyline
              points={tScoreModel.points.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke={meta.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            {tScoreModel.points.map((p, i) => (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r="5" fill={gasScoreTone(p.score)} stroke="#fff" strokeWidth="2" />
                <circle cx={p.x} cy={p.y} r="14" fill="transparent" style={{ cursor: 'pointer' }}
                  onMouseEnter={e => {
                    const wrap = e.currentTarget.closest('.cp-wrap').getBoundingClientRect();
                    const r = e.currentTarget.getBoundingClientRect();
                    setTScoreTip({
                      left: Math.max(130, Math.min(wrap.width - 130, r.left - wrap.left + r.width / 2)),
                      top: r.top - wrap.top,
                      score: p.score, date: fullDate(p.date),
                      therapist: p.entry.therapist_name,
                      remarks: p.entry.remarks,
                      goals: (p.entry.scores || []).map(s => `${s.item_title}: ${s.level > 0 ? '+' + s.level : s.level}`)
                    });
                  }}
                  onMouseLeave={() => setTScoreTip(null)} />
              </g>
            ))}
          </svg>

          {tScoreTip && (
            <div className="cp-tip" style={{ left: tScoreTip.left, top: tScoreTip.top }}>
              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 2 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: gasScoreTone(tScoreTip.score), display: 'inline-block' }} />
                T-Score: {tScoreTip.score}
              </div>
              <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 6 }}>
                <i className="fa-regular fa-calendar" style={{ marginRight: 4 }} />
                {tScoreTip.date}{tScoreTip.therapist ? ' · ' + tScoreTip.therapist : ''}
              </div>
              {tScoreTip.goals.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 3 }}>Goals Scored</div>
                  <div style={{ fontSize: 11, color: '#CBD5E1', lineHeight: 1.6 }}>
                    {tScoreTip.goals.map((g, i) => <div key={i}>{g}</div>)}
                  </div>
                </>
              )}
              {tScoreTip.remarks && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.5px', marginTop: 6, marginBottom: 2 }}>Therapist Remarks</div>
                  <div style={{ color: '#CBD5E1', fontSize: 11.5 }}>
                    <i className="fa-regular fa-note-sticky" style={{ marginRight: 4, opacity: .7 }} />
                    "{tScoreTip.remarks}"
                  </div>
                </>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 6, fontSize: 11, color: '#64748B', flexWrap: 'wrap' }}>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: '#10B981', marginRight: 4 }} />T >= 60 (above expected)</span>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: '#0EA5E9', marginRight: 4 }} />45–59 (at expected)</span>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: '#F59E0B', marginRight: 4 }} />35–44 (below expected)</span>
            <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: '#EF4444', marginRight: 4 }} />Below 35</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main exported component ── */
export default function GasProgressChart({ entries }) {
  // Group entries by discipline
  const byDiscipline = useMemo(() => {
    const map = {};
    for (const e of entries || []) {
      const d = e.discipline || 'Unknown';
      if (!map[d]) map[d] = [];
      map[d].push(e);
    }
    return map;
  }, [entries]);

  const disciplines = Object.keys(byDiscipline);

  if (!disciplines.length) {
    return (
      <div style={{ padding: 30, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
        No GAS entries recorded yet for this client.
      </div>
    );
  }

  // Render in a fixed order: OT first, then Speech
  const order = ['Occupational Therapy', 'Speech-Language Therapy'];
  const ordered = [...disciplines].sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ordered.map(d => (
        <DisciplineChart key={d} discipline={d} entries={byDiscipline[d]} />
      ))}
    </div>
  );
}

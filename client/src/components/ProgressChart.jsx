import { useMemo, useState } from 'react';

const COLORS = {
  'Fine Motor': '#0EA5E9',
  'Speech & Language': '#F59E0B',
  'Social & Behavioral': '#818CF8',
  'Cognitive': '#10B981'
};
const FALLBACK = ['#0EA5E9', '#F59E0B', '#818CF8', '#10B981', '#EC4899'];

/**
 * Multi-line development trend chart with hover tooltips showing the
 * therapist's qualitative remarks, ported from the mockup (7.1.d.a).
 * props.domains = { 'Fine Motor': [{date, score, remark, next_plan, tags, therapist}], ... }
 */
export default function ProgressChart({ domains }) {
  const [tip, setTip] = useState(null);

  const model = useMemo(() => {
    const names = Object.keys(domains || {});
    const allDates = [...new Set(names.flatMap(n => domains[n].map(p => p.date)))].sort();
    if (!allDates.length) return null;
    const W = 640, H = 210, x0 = 34, x1 = 520, y0 = 180, y1 = 14;
    const xFor = d => allDates.length === 1 ? (x0 + x1) / 2 : x0 + (allDates.indexOf(d) / (allDates.length - 1)) * (x1 - x0);
    const yFor = s => y0 - (s / 100) * (y0 - y1);
    const series = names.map((n, i) => ({
      name: n,
      color: COLORS[n] || FALLBACK[i % FALLBACK.length],
      pts: domains[n].map(p => ({ ...p, x: xFor(p.date), y: yFor(p.score) }))
    }));
    // spread end labels so they never overlap
    const ends = series.map(s => ({ s, y: s.pts[s.pts.length - 1]?.y ?? 0 })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    return { W, H, series, allDates, xFor, ends };
  }, [domains]);

  if (!model) return <div style={{ padding: 30, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No session notes recorded yet.</div>;

  const monthLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' });
  const fullDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="cp-wrap">
      <svg width="100%" height="230" viewBox={`0 0 ${model.W} ${model.H + 20}`} style={{ overflow: 'visible', display: 'block' }}>
        {[[100, 14], [75, 55.5], [50, 97], [25, 138.5], [0, 180]].map(([v, y]) => (
          <g key={v}>
            <line x1="34" y1={y} x2="520" y2={y} stroke="#F1F5F9" />
            <text x="28" y={y + 3} fontSize="9.5" fill="#94A3B8" textAnchor="end">{v}</text>
          </g>
        ))}
        {model.allDates.map(d => (
          <text key={d} x={model.xFor(d)} y={model.H + 16} fontSize="10" fill="#94A3B8" textAnchor="middle">{monthLabel(d)}</text>
        ))}
        {model.series.map(s => (
          <polyline key={s.name} points={s.pts.map(p => `${p.x},${p.y}`).join(' ')}
            fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {model.series.map(s => s.pts.map((p, i) => (
          <g key={s.name + i}>
            <circle cx={p.x} cy={p.y} r="4" fill={s.color} stroke="#fff" strokeWidth="1.5" />
            <circle cx={p.x} cy={p.y} r="12" fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={e => {
                const wrap = e.currentTarget.closest('.cp-wrap').getBoundingClientRect();
                const r = e.currentTarget.getBoundingClientRect();
                setTip({
                  left: Math.max(120, Math.min(wrap.width - 120, r.left - wrap.left + r.width / 2)),
                  top: r.top - wrap.top,
                  domain: s.name, color: s.color, date: fullDate(p.date),
                  score: p.score, remark: p.remark, next: p.next_plan, tags: p.tags || [], therapist: p.therapist
                });
              }}
              onMouseLeave={() => setTip(null)} />
          </g>
        )))}
        {model.ends.map(({ s, y }) => (
          <text key={s.name} x="528" y={y + 3} fontSize="10" fontWeight="600" fill="#475569">{s.name}</text>
        ))}
      </svg>

      {tip && (
        <div className="cp-tip" style={{ left: tip.left, top: tip.top }}>
          <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, marginBottom: 2 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: tip.color, display: 'inline-block' }} />
            {tip.domain} · {tip.score}% completion
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 6 }}>
            <i className="fa-regular fa-calendar" style={{ marginRight: 4 }} />
            {tip.date}{tip.therapist ? ' · session with ' + tip.therapist : ''}
          </div>
          {tip.tags.length > 0 && (
            <>
              <div className="tt-section">Behavioral Tags</div>
              <div>{tip.tags.map(t => <span key={t} className="tt-tag">{t}</span>)}</div>
            </>
          )}
          <div className="tt-section">Therapist Remarks</div>
          <div style={{ color: '#CBD5E1', fontSize: 11.5 }}>
            <i className="fa-regular fa-note-sticky" style={{ marginRight: 4, opacity: .7 }} />
            {tip.remark ? '“' + tip.remark + '”' : 'Session completed, progress logged.'}
          </div>
          {tip.next && (
            <>
              <div className="tt-section">Next Session Recommendation</div>
              <div style={{ color: '#6EE7B7', fontSize: 11, fontWeight: 600 }}>
                <i className="fa-solid fa-arrow-right" style={{ marginRight: 4, fontSize: 10 }} />{tip.next}
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
        {model.series.map(s => (
          <span key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#475569', fontWeight: 600 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, display: 'inline-block' }} />{s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

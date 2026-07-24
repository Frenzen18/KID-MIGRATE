/**
 * Bar chart of the goal levels currently set on the During Session sliders
 * (−2 to +2), one horizontal bar per goal, centered on the 0 (expected outcome) line.
 *
 * Props:
 *   items: GAS questionnaire items [{ id, title, weight }]
 *   scores: { [itemId]: level } map, as edited by the session sliders
 */

// Same 8-slot categorical order used everywhere else (see --cat-1..8 in shared.css).
const GOAL_COLORS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)', 'var(--cat-7)', 'var(--cat-8)'];

// Level sign is state (above/at/below expected outcome), not identity, so it
// draws from the reserved status colors instead of the categorical set above.
function levelTone(level) {
  if (level > 0) return 'var(--color-success)';
  if (level === 0) return 'var(--color-info)';
  return 'var(--color-danger-strong)';
}

export default function GoalLevelBarChart({ items, scores }) {
  if (!items?.length) {
    return <div style={{ padding: '20px 0', textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>No goals to chart yet.</div>;
  }

  const trackW = 100; // % width available to either side of the center line

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => {
        const level = scores[it.id] ?? 0;
        const color = GOAL_COLORS[i % GOAL_COLORS.length];
        const widthPct = (Math.abs(level) / 2) * trackW;
        return (
          <div key={it.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#334155' }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color, marginRight: 5 }} />
                {it.title}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: levelTone(level) }}>{level > 0 ? '+' + level : level}</span>
            </div>
            <div style={{ position: 'relative', height: 8, background: '#F1F5F9', borderRadius: 4 }}>
              <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: '#CBD5E1' }} />
              {level >= 0 ? (
                <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: widthPct / 2 + '%', background: color, borderRadius: '0 4px 4px 0' }} />
              ) : (
                <div style={{ position: 'absolute', right: '50%', top: 0, bottom: 0, width: widthPct / 2 + '%', background: color, borderRadius: '4px 0 0 4px' }} />
              )}
            </div>
          </div>
        );
      })}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: '#94A3B8', marginTop: 2 }}>
        <span>-2</span><span>-1</span><span>0</span><span>+1</span><span>+2</span>
      </div>
    </div>
  );
}

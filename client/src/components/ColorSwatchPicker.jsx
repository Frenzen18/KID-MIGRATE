import { useState, useRef, useEffect } from 'react';

// A calm, curated palette instead of the browser's native color-wheel input
// (fully saturated, harsh, and looks different on every OS/browser). The same
// swatch set serves every branding field, vivid accents down through neutrals,
// since one field might be a button color and the next a page background.
const PALETTE = [
  '#0EA5E9', '#0D9488', '#1F4E9E', '#6366F1', '#8B5CF6', '#D946EF', '#EC4899', '#F43F5E',
  '#F59E0B', '#F97316', '#EAB308', '#84CC16', '#22C55E', '#10B981', '#14B8A6', '#06B6D4',
  '#FFFFFF', '#F8FAFC', '#F1F5F9', '#E2E8F0', '#CBD5E1', '#94A3B8', '#64748B', '#475569',
  '#334155', '#1E293B', '#182238', '#0F172A'
];

/**
 * Swatch-grid color picker used across Branding & Theme, in place of the
 * native <input type="color"> wheel. Falls back to that same native input
 * only for the "Custom…" slot, so an exact/off-palette hex is still reachable.
 */
export default function ColorSwatchPicker({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        aria-label="Choose color"
        style={{ width: 40, height: 38, borderRadius: 8, border: '1px solid #E2E8F0', background: value || '#FFFFFF', cursor: disabled ? 'default' : 'pointer', padding: 0, boxShadow: 'inset 0 0 0 1px rgba(15,23,42,.04)' }}
      />
      {open && (
        <div style={{ position: 'absolute', zIndex: 30, top: '100%', left: 0, marginTop: 6, padding: 12, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10, boxShadow: '0 8px 24px rgba(15,23,42,.14)', width: 208 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {PALETTE.map(c => {
              const active = c.toLowerCase() === (value || '').toLowerCase();
              return (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => { onChange(c); setOpen(false); }}
                  style={{
                    width: 22, height: 22, borderRadius: 6, background: c, cursor: 'pointer', padding: 0,
                    border: active ? '2px solid #0EA5E9' : '1px solid rgba(15,23,42,.08)',
                    outline: active ? '1px solid #fff' : 'none', outlineOffset: active ? -3 : 0
                  }}
                />
              );
            })}
          </div>
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, flex: 1 }}>Custom…</span>
            <input
              type="color"
              value={value || '#FFFFFF'}
              onChange={e => onChange(e.target.value)}
              style={{ width: 26, height: 26, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0 }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

import { createContext, useContext, useRef, useState } from 'react';

/* ── Toast ── */
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  function show(msg, icon = 'fa-circle-check') {
    setToast({ msg, icon });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  }
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div id="toast" className={toast ? 'show' : ''}>
        <i className={'fa-solid ' + (toast?.icon || 'fa-circle-check')} style={{ color: '#0EA5E9' }} />
        <span>{toast?.msg}</span>
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ── Modal ── */
export function Modal({ title, onClose, children, width }) {
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box" style={width ? { maxWidth: width } : undefined}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: '#0F172A', margin: 0, fontFamily: 'Poppins,sans-serif' }}>{title}</h2>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#64748B', cursor: 'pointer' }}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── Stat card ── */
export function StatCard({ label, value, change, up = true, icon, color = '#0EA5E9', bg = '#E0F2FE' }) {
  return (
    <div className="card stat-card" style={{ borderTop: `3px solid ${color}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div className="stat-label">{label}</div>
          <div className="stat-value">{value}</div>
          {change && <div className={'stat-change ' + (up ? 'up' : 'down')}>{change}</div>}
        </div>
        <div className="stat-icon" style={{ background: bg, color }}>
          <i className={'fa-solid ' + icon} />
        </div>
      </div>
    </div>
  );
}

export const Pill = ({ tone = 'blue', children }) => <span className={'pill pill-' + tone}>{children}</span>;

/* ── Shared loading / empty states ──
   Consolidates the many hand-rolled "spinner + message" and "nothing here"
   blocks that were duplicated with slightly different padding/colors across
   Clients.jsx, Reservations.jsx, Milestones.jsx, Users.jsx, ParentPortal.jsx,
   MyCalendar.jsx, etc. New call sites should use these instead of re-rolling
   the same markup; existing ones can migrate incrementally. */
export function LoadingState({ label = 'Loading…', padding = 40, fontSize = 13, iconSize = 22, color = '#94A3B8' }) {
  return (
    <div style={{ padding, textAlign: 'center', color }}>
      <i className="fa-solid fa-spinner fa-spin" style={{ fontSize: iconSize }} />
      <div style={{ marginTop: 10, fontSize }}>{label}</div>
    </div>
  );
}

export function EmptyState({ label = 'Nothing here yet', icon = 'fa-inbox', padding = 32, fontSize = 13 }) {
  return (
    <div style={{ padding, textAlign: 'center', color: '#94A3B8', fontSize }}>
      <i className={'fa-solid ' + icon} style={{ marginRight: 8 }} />{label}
    </div>
  );
}

/** Same as EmptyState/LoadingState but pre-wrapped in a <tr><td> for direct use inside a <tbody>. */
export function TableEmptyRow({ colSpan, label = 'Nothing here yet', icon = 'fa-inbox', padding = 32 }) {
  return (
    <tr><td colSpan={colSpan} style={{ textAlign: 'center', padding, color: '#94A3B8', fontSize: 13 }}>
      <i className={'fa-solid ' + icon} style={{ marginRight: 8 }} />{label}
    </td></tr>
  );
}

export function TableLoadingRow({ colSpan, label = 'Loading…', padding = 32 }) {
  return (
    <tr><td colSpan={colSpan} style={{ textAlign: 'center', padding, color: '#94A3B8', fontSize: 13 }}>
      <i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />{label}
    </td></tr>
  );
}

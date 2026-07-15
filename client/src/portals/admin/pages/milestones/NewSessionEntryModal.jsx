import { Modal } from '../../../../components/ui.jsx';

/** Static mockup form, not wired to a real API endpoint (see the onClick handler:
 *  it only toasts and closes). Kept exactly as-is, just moved out of Milestones.jsx. */
export default function NewSessionEntryModal({ onClose, toast }) {
  return (
    <Modal title="Log New Session Entry" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Client *</label>
          <select className="form-select"><option>- Select client -</option><option>Jake Lim, CLI-0204</option><option>Sofia Ramos, CLI-0189</option><option>Ana Torres, CLI-0156</option></select>
        </div>
        <div><label className="form-label">Session Date *</label><input className="form-input" type="date" /></div>
        <div><label className="form-label">Therapist</label>
          <select className="form-select"><option>Maria Santos (OT)</option><option>Jose Reyes (Speech)</option></select>
        </div>
        <div><label className="form-label">Progress Score (0–100%) *</label><input className="form-input score-input" type="number" min="0" max="100" placeholder="e.g. 78" /></div>
        <div><label className="form-label">Milestones Hit / Total</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input className="form-input" type="number" min="0" placeholder="hit" style={{ flex: 1 }} /><span style={{ color: '#94A3B8' }}>/</span><input className="form-input" type="number" min="1" placeholder="total" style={{ flex: 1 }} /></div>
        </div>
        <div><label className="form-label">Attendance</label>
          <select className="form-select"><option>✅ Present</option><option>❌ Absent</option><option>🕐 Late Arrival</option><option>📋 Excused</option></select>
        </div>
        <div><label className="form-label">Sessions This Month</label><input className="form-input" type="number" defaultValue="8" min="0" /></div>
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Clinical Remarks</label>
          <textarea className="form-input" rows="3" style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }} placeholder="Enter clinical observations and remarks…" />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => { onClose(); toast('Session entry submitted, locks in 24h', 'fa-lock'); }}>
          <i className="fa-solid fa-paper-plane" style={{ marginRight: 5 }} />Submit Entry
        </button>
      </div>
    </Modal>
  );
}

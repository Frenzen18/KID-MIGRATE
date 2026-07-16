import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';

export default function EditShiftModal({ data, closeModal, toast }) {
  const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 6 AM … 9 PM
  const hourLabel = h => (h % 12 === 0 ? 12 : h % 12) + ':00 ' + (h >= 12 ? 'PM' : 'AM');
  const [startHour, setStartHour] = useState(data.start_hour ?? 8);
  const [endHour, setEndHour] = useState(data.end_hour ?? 17);
  const endOptions = HOURS.filter(h => h > startHour);

  // Lunch break is optional, an hour range within the shift with no bookings.
  const hasInitialLunch = data.lunch_start_hour != null && data.lunch_end_hour != null;
  const [hasLunch, setHasLunch] = useState(hasInitialLunch);
  const [lunchStart, setLunchStart] = useState(data.lunch_start_hour ?? 12);
  const [lunchEnd, setLunchEnd] = useState(data.lunch_end_hour ?? 13);
  // Lunch must fall within the (possibly just-changed) shift hours.
  const lunchStartOptions = HOURS.filter(h => h >= startHour && h < endHour);
  const lunchEndOptions = HOURS.filter(h => h > lunchStart && h <= endHour);

  const submitShift = async () => {
    if (startHour >= endHour) {
      toast('Shift start must be before shift end', 'fa-triangle-exclamation');
      return;
    }
    if (hasLunch && (lunchStart < startHour || lunchEnd > endHour || lunchStart >= lunchEnd)) {
      toast('Lunch break must fall within the shift hours', 'fa-triangle-exclamation');
      return;
    }
    const ok = await data.onSave?.({
      start_hour: startHour,
      end_hour: endHour,
      lunch_start_hour: hasLunch ? lunchStart : null,
      lunch_end_hour: hasLunch ? lunchEnd : null
    });
    if (ok !== false) closeModal();
  };
  return (
    <Modal title={<><i className="fa-solid fa-calendar-pen" style={{ color: '#0EA5E9', marginRight: 8 }} />Edit Shift{data.name ? ': ' + data.name : ''}</>} onClose={closeModal} width={440}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label className="form-label">Shift Start</label>
          <select id="es-start" className="form-select" value={startHour} onChange={e => {
            const newStart = parseInt(e.target.value, 10);
            setStartHour(newStart);
            // Keep End valid: if it's no longer after the new Start, bump it to the next hour.
            if (endHour <= newStart) setEndHour(Math.min(newStart + 1, HOURS[HOURS.length - 1]));
          }}>
            {HOURS.slice(0, -1).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </div>
        <div><label className="form-label">Shift End</label>
          <select id="es-end" className="form-select" value={endHour} onChange={e => setEndHour(parseInt(e.target.value, 10))}>
            {endOptions.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: '#334155', cursor: lunchStartOptions.length ? 'pointer' : 'not-allowed' }}>
          <input type="checkbox" checked={hasLunch && !!lunchStartOptions.length} disabled={!lunchStartOptions.length} onChange={e => {
            setHasLunch(e.target.checked);
            if (e.target.checked) {
              const ls = lunchStart >= startHour && lunchStart < endHour ? lunchStart : lunchStartOptions[0];
              setLunchStart(ls);
              setLunchEnd(Math.min(ls + 1, endHour));
            }
          }} />
          Set a lunch break
        </label>
        {!lunchStartOptions.length && (
          <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 4 }}>Shift is too short for a lunch break.</div>
        )}
        {hasLunch && !!lunchStartOptions.length && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 10 }}>
            <div><label className="form-label">Lunch Start</label>
              <select className="form-select" value={lunchStart} onChange={e => {
                const ls = parseInt(e.target.value, 10);
                setLunchStart(ls);
                if (lunchEnd <= ls) setLunchEnd(Math.min(ls + 1, endHour));
              }}>
                {lunchStartOptions.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <div><label className="form-label">Lunch End</label>
              <select className="form-select" value={lunchEnd} onChange={e => setLunchEnd(parseInt(e.target.value, 10))}>
                {lunchEndOptions.map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>
      <div style={{ marginTop: 14, padding: '10px 13px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 12, color: '#92400E', lineHeight: 1.5 }}>
        <i className="fa-solid fa-circle-info" style={{ marginRight: 6 }} />Shifts control booking availability. Confirmed sessions that fall outside the new hours, or inside a new lunch break, are flagged for rescheduling and the parents are notified automatically.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={submitShift}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Update Shift</button></div>
    </Modal>
  );
}

import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';

export default function EditShiftModal({ data, closeModal, toast }) {
  const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 6 AM … 9 PM
  const hourLabel = h => (h % 12 === 0 ? 12 : h % 12) + ':00 ' + (h >= 12 ? 'PM' : 'AM');
  const [startHour, setStartHour] = useState(data.start_hour ?? 8);
  const [endHour, setEndHour] = useState(data.end_hour ?? 17);
  const endOptions = HOURS.filter(h => h > startHour);
  const submitShift = async () => {
    if (startHour >= endHour) {
      toast('Shift start must be before shift end', 'fa-triangle-exclamation');
      return;
    }
    const ok = data.onSave ? await data.onSave({ start_hour: startHour, end_hour: endHour }) : true;
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
      <div style={{ marginTop: 14, padding: '10px 13px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, fontSize: 12, color: '#92400E', lineHeight: 1.5 }}>
        <i className="fa-solid fa-circle-info" style={{ marginRight: 6 }} />Shifts control booking availability. Confirmed sessions that fall outside the new hours are flagged for rescheduling and the parents are notified automatically.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={submitShift}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Update Shift</button></div>
    </Modal>
  );
}

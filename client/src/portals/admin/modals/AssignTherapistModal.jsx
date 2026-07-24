import { useState, useEffect } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { api } from '../../../api.js';

/**
 * Assigns a therapist to an existing, currently-unassigned reservation
 * (an Initial Assessment, most often, those are booked without one on
 * purpose, see server/routes/reservations.js). Only offers therapists
 * actually free at the reservation's own date/time, fetched fresh from
 * the same slot-availability endpoint the booking calendar itself uses,
 * rather than a fixed list that could double-book someone.
 */
export default function AssignTherapistModal({ data, closeModal, toast }) {
  const [therapists, setTherapists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/reservations/slots?date=' + data.date)
      .then(slots => {
        const slot = (slots || []).find(s => s.time_slot === data.timeSlot);
        setTherapists(slot?.therapists || []);
      })
      .catch(() => setTherapists([]))
      .finally(() => setLoading(false));
  }, [data.date, data.timeSlot]);

  async function submit() {
    if (!picked) { toast('Select a therapist', 'fa-triangle-exclamation'); return; }
    setSaving(true);
    try {
      await data.onSave(picked);
      closeModal();
    } catch (e) {
      toast(e.message || 'Failed to assign therapist', 'fa-triangle-exclamation');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Assign Therapist" onClose={closeModal} width={440}>
      <div style={{ marginBottom: 14 }}>
        <label className="form-label">Reservation</label>
        <input type="text" className="form-input" readOnly style={{ background: '#F1F5F9' }}
          value={`${data.clientName}, ${data.date}, ${data.timeSlot}`} />
      </div>
      <div style={{ marginBottom: 20 }}>
        <label className="form-label">Select Therapist</label>
        {loading ? (
          <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '8px 0' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading who's free at that time…</div>
        ) : therapists.length === 0 ? (
          <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '8px 0' }}>No therapist is free at this reservation's date/time anymore.</div>
        ) : (
          <select className="form-select" value={picked} onChange={e => setPicked(e.target.value)}>
            <option value="">- Select a therapist -</option>
            {therapists.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" onClick={closeModal} disabled={saving}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={saving || !therapists.length}>{saving ? 'Assigning…' : 'Assign'}</button>
      </div>
    </Modal>
  );
}

import { Modal } from '../../../components/ui.jsx';

export default function AssignTherapistModal({ closeModal, toast }) {
  return (
    <Modal title="Assign Therapist" onClose={closeModal} width={440}>
      <div style={{ marginBottom: 14 }}><label className="form-label">Reservation</label><input type="text" className="form-input" defaultValue="Lim, Jake, Jun 28, 9:00 AM" readOnly style={{ background: '#F1F5F9' }} /></div>
      <div style={{ marginBottom: 20 }}><label className="form-label">Select Therapist</label><select className="form-select"><option>Maria Santos (OT)</option><option>Tessa Mendoza (OT)</option><option>Jose Reyes (Speech)</option><option>Nina Alvarado (Speech)</option></select></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={() => { closeModal(); toast('Therapist assigned successfully', 'fa-user-doctor'); }}>Assign</button></div>
    </Modal>
  );
}

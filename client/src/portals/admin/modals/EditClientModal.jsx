import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';

export default function EditClientModal({ data, closeModal, toast }) {
  const [first = '', last = ''] = (data.name || '').split(' ');
  // Real registered ot/speech accounts (passed in from Clients.jsx's own /api/shifts fetch,
  // the same live data source Reservations.jsx's Employee Scheduling tab uses), not a fabricated list.
  const therapistRoleAbbr = { ot: 'OT', speech: 'Speech' };
  const therapists = (data.therapists || []).map(t => `${t.name} (${therapistRoleAbbr[t.role] || t.role})`);
  const statuses = ['Active', 'On Hold', 'Discharged', 'New'];
  const statusPillClass = { Active: 'pill pill-green', 'On Hold': 'pill pill-amber', Discharged: 'pill pill-red', New: 'pill pill-blue' };
  // Labels shown in the dropdown map to the DB's therapy_type values ('OT' | 'Speech' | 'Both').
  // A client isn't required to have a therapy type or therapist yet, both start unset until
  // the clinic makes an assessment, so "Not yet assigned" is a real, selectable option here,
  // not just a display fallback.
  const therapyLabels = { OT: 'Occupational Therapy', Speech: 'Speech Therapy', Both: 'Combined' };
  const therapyValues = { 'Occupational Therapy': 'OT', 'Speech Therapy': 'Speech', 'Combined': 'Both' };
  const [therapyLabel, setTherapyLabel] = useState(therapyLabels[data.therapy_type] || '');
  const therapyType = therapyValues[therapyLabel] || '';
  // Combined clients can be assigned any therapist; OT/Speech-only clients only see therapists of that discipline.
  // No therapy type chosen yet means no therapist can be chosen yet either.
  const visibleTherapists = therapyType === '' ? [] : therapyType === 'Both' ? therapists : therapists.filter(t => t.endsWith('(' + therapyType + ')'));
  // Must come from visibleTherapists, not the full unfiltered list, otherwise the
  // preselected value could be a therapist not shown in the dropdown's own options,
  // and saving without touching the field would silently assign the wrong person.
  const defaultTherapist = visibleTherapists.find(t => data.thxName && t.startsWith(data.thxName.split(' ')[0])) || '';
  const [therapistVal, setTherapistVal] = useState(defaultTherapist);

  function changeTherapyType(newLabel) {
    setTherapyLabel(newLabel);
    const newType = therapyValues[newLabel] || '';
    const stillVisible = newType !== '' && (newType === 'Both' || therapistVal.endsWith('(' + newType + ')'));
    if (!stillVisible) setTherapistVal('');
  }

  return (
    <Modal title={<><i className="fa-solid fa-user-pen" style={{ color: '#0EA5E9', marginRight: 8 }} />Edit Client Profile</>} onClose={closeModal} width={440}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label className="form-label">First Name</label><input id="ec-first" className="form-input" defaultValue={first} /></div>
        <div><label className="form-label">Last Name</label><input id="ec-last" className="form-input" defaultValue={last} /></div>
        <div><label className="form-label">Guardian</label><input id="ec-guardian" className="form-input" defaultValue={data.guardian || ''} /></div>
        <div><label className="form-label">Status</label><select id="ec-status" className="form-select" defaultValue={statuses.includes(data.status) ? data.status : statuses[0]}>{statuses.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><label className="form-label">Therapy Type</label><select id="ec-therapy" className="form-select" value={therapyLabel} onChange={e => changeTherapyType(e.target.value)}><option value="">Not yet assigned</option><option>Occupational Therapy</option><option>Speech Therapy</option><option>Combined</option></select></div>
        <div>
          <label className="form-label">Assigned Therapist</label>
          {therapyType === '' ? (
            <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC' }}>Choose a therapy type first</div>
          ) : visibleTherapists.length ? (
            <select id="ec-therapist" className="form-select" value={therapistVal} onChange={e => setTherapistVal(e.target.value)}><option value="">Not yet assigned</option>{visibleTherapists.map(t => <option key={t} value={t}>{t}</option>)}</select>
          ) : (
            <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC' }}>No registered {therapyType === 'Both' ? '' : therapyType + ' '}therapists yet</div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={() => {
        const firstVal = document.getElementById('ec-first').value.trim();
        const lastVal = document.getElementById('ec-last').value.trim();
        const guardian = document.getElementById('ec-guardian').value.trim();
        const status = document.getElementById('ec-status').value;
        const therapy_type = therapyType;
        const thxName = therapistVal.replace(/ \(.*\)/, '');
        const fullName = firstVal + (lastVal ? ' ' + lastVal : '');
        const cb = data.onSave;
        closeModal();
        if (cb) cb({ name: fullName, initials: (firstVal[0] || '') + (lastVal[0] || ''), guardian, status, statusPill: statusPillClass[status] || 'pill pill-green', thxName, therapy_type });
        toast('Client profile updated: ' + fullName, 'fa-check');
      }}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Save Changes</button></div>
    </Modal>
  );
}

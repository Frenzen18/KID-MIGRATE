import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { sanitizeNameInput, hasInvalidNameChars, INVALID_NAME_MSG } from '../../../nameInput.js';

/** Live-filters a name field and toggles its sibling `${noteId}` warning div. */
function onNameInput(noteId) {
  return e => {
    const note = document.getElementById(noteId);
    if (note) note.style.display = hasInvalidNameChars(e.target.value) ? 'block' : 'none';
    e.target.value = sanitizeNameInput(e.target.value);
  };
}

export default function EditClientModal({ data, closeModal, toast }) {
  const [first = '', last = ''] = (data.name || '').split(' ');
  // Real registered ot/speech accounts (passed in from Clients.jsx's own /api/shifts fetch,
  // the same live data source Reservations.jsx's Employee Scheduling tab uses), not a fabricated list.
  const therapistRoleAbbr = { ot: 'OT', speech: 'Speech' };
  const therapists = (data.therapists || []).map(t => `${t.name} (${therapistRoleAbbr[t.role] || t.role})`);
  // Labels shown in the dropdown map to the DB's therapy_type values ('OT' | 'Speech' | 'Both').
  // A client isn't required to have a therapy type or therapist yet, both start unset until
  // the clinic makes an assessment, so "Not yet assigned" is a real, selectable option here,
  // not just a display fallback.
  const therapyLabels = { OT: 'Occupational Therapy', Speech: 'Speech Therapy', Both: 'Combined' };
  const therapyValues = { 'Occupational Therapy': 'OT', 'Speech Therapy': 'Speech', 'Combined': 'Both' };
  const [therapyLabel, setTherapyLabel] = useState(therapyLabels[data.therapy_type] || '');
  const therapyType = therapyValues[therapyLabel] || '';
  // Combined clients get two independent assignments (one OT, one Speech), never a
  // single shared field, each dropdown only ever lists therapists of its own discipline.
  const showOt = therapyType === 'OT' || therapyType === 'Both';
  const showSpeech = therapyType === 'Speech' || therapyType === 'Both';
  const visibleOtTherapists = therapists.filter(t => t.endsWith('(OT)'));
  const visibleSpeechTherapists = therapists.filter(t => t.endsWith('(Speech)'));
  // Must come from the visible list, not the full unfiltered one, otherwise the
  // preselected value could be a therapist not shown in the dropdown's own options,
  // and saving without touching the field would silently assign the wrong person.
  const defaultOtTherapist = visibleOtTherapists.find(t => data.assignedOt && t.startsWith(data.assignedOt.split(' ')[0])) || '';
  const defaultSpeechTherapist = visibleSpeechTherapists.find(t => data.assignedSpeech && t.startsWith(data.assignedSpeech.split(' ')[0])) || '';
  const [otTherapistVal, setOtTherapistVal] = useState(defaultOtTherapist);
  const [speechTherapistVal, setSpeechTherapistVal] = useState(defaultSpeechTherapist);

  function changeTherapyType(newLabel) {
    setTherapyLabel(newLabel);
    const newType = therapyValues[newLabel] || '';
    if (newType !== 'OT' && newType !== 'Both') setOtTherapistVal('');
    if (newType !== 'Speech' && newType !== 'Both') setSpeechTherapistVal('');
  }

  return (
    <Modal title={<><i className="fa-solid fa-user-pen" style={{ color: '#0EA5E9', marginRight: 8 }} />Edit Client Profile</>} onClose={closeModal} width={440}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label className="form-label">First Name</label><input id="ec-first" className="form-input" defaultValue={first} onInput={onNameInput('ec-first-note')} /><div id="ec-first-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Last Name</label><input id="ec-last" className="form-input" defaultValue={last} onInput={onNameInput('ec-last-note')} /><div id="ec-last-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div><label className="form-label">Guardian</label><input id="ec-guardian" className="form-input" defaultValue={data.guardian || ''} onInput={onNameInput('ec-guardian-note')} /><div id="ec-guardian-note" style={{ display: 'none', fontSize: 11, color: '#DC2626', marginTop: 4 }}>{INVALID_NAME_MSG}</div></div>
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Therapy Type</label><select id="ec-therapy" className="form-select" value={therapyLabel} onChange={e => changeTherapyType(e.target.value)}><option value="">Not yet assigned</option><option>Occupational Therapy</option><option>Speech Therapy</option><option>Combined</option></select></div>
        {therapyType === '' ? (
          <div style={{ gridColumn: '1/-1' }}>
            <label className="form-label">Assigned Therapist</label>
            <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC' }}>Choose a therapy type first</div>
          </div>
        ) : (
          <>
            {showOt && (
              <div style={{ gridColumn: therapyType === 'Both' ? undefined : '1/-1' }}>
                <label className="form-label">Occupational Therapist</label>
                {visibleOtTherapists.length ? (
                  <select id="ec-therapist-ot" className="form-select" value={otTherapistVal} onChange={e => setOtTherapistVal(e.target.value)}><option value="">Not yet assigned</option>{visibleOtTherapists.map(t => <option key={t} value={t}>{t}</option>)}</select>
                ) : (
                  <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC' }}>No registered OT therapists yet</div>
                )}
              </div>
            )}
            {showSpeech && (
              <div style={{ gridColumn: therapyType === 'Both' ? undefined : '1/-1' }}>
                <label className="form-label">Speech-Language Therapist</label>
                {visibleSpeechTherapists.length ? (
                  <select id="ec-therapist-speech" className="form-select" value={speechTherapistVal} onChange={e => setSpeechTherapistVal(e.target.value)}><option value="">Not yet assigned</option>{visibleSpeechTherapists.map(t => <option key={t} value={t}>{t}</option>)}</select>
                ) : (
                  <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#94A3B8', background: '#F8FAFC' }}>No registered Speech therapists yet</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}><button className="btn-secondary" onClick={closeModal}>Cancel</button><button className="btn-primary" onClick={() => {
        const firstVal = document.getElementById('ec-first').value.trim();
        const lastVal = document.getElementById('ec-last').value.trim();
        const guardian = document.getElementById('ec-guardian').value.trim();
        const therapy_type = therapyType;
        const thxOt = showOt ? otTherapistVal.replace(/ \(.*\)/, '') : '';
        const thxSpeech = showSpeech ? speechTherapistVal.replace(/ \(.*\)/, '') : '';
        const fullName = firstVal + (lastVal ? ' ' + lastVal : '');
        const cb = data.onSave;
        closeModal();
        if (cb) cb({ name: fullName, initials: (firstVal[0] || '') + (lastVal[0] || ''), guardian, thxOt, thxSpeech, therapy_type });
        toast('Client profile updated: ' + fullName, 'fa-check');
      }}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Save Changes</button></div>
    </Modal>
  );
}

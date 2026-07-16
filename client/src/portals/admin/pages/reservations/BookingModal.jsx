import { useEffect, useState } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { api } from '../../../../api.js';
import { rateForSessionType, effectiveSlotAvailable, REQUIRED_ROLE_FOR_TYPE, therapistWorksOn } from './reservationsHelpers.js';

export default function BookingModal({ selected, daySlots, slotState, defaultTime, time, clients, clientLabel, serviceType, busy, onClose, onConfirm }) {
  const requiredRole = REQUIRED_ROLE_FOR_TYPE[serviceType] || null;

  // Initial Assessment is for intake, only clients with neither a therapy type
  // nor an assigned therapist yet are eligible, anyone with either already set
  // has already been through intake.
  const isInitialAssessment = serviceType === 'Initial Assessment';
  // Speech-Language/Occupational Assessment are follow-ups for clients already
  // designated into that discipline (or Combined), not a fresh intake, so only
  // clients matching that therapy_type are selectable.
  const DISCIPLINE_FOR_TYPE = { 'Speech-Language Assessment': 'Speech', 'Occupational Assessment': 'OT' };
  const requiredDiscipline = DISCIPLINE_FOR_TYPE[serviceType];
  const bookableClients = isInitialAssessment
    ? clients.filter(c => !c.assigned_therapist_name && !c.therapy_type)
    : requiredDiscipline
      ? clients.filter(c => c.therapy_type === requiredDiscipline || c.therapy_type === 'Both')
      : clients;

  const [selectedClientId, setSelectedClientId] = useState('');

  // Searchable client picker: types to filter, shows at most 4 matches at a
  // time instead of one long native <select> of every eligible client.
  const [clientSearch, setClientSearch] = useState('');
  const [clientDropdownOpen, setClientDropdownOpen] = useState(false);
  const clientMatches = bookableClients
    .filter(c => clientLabel(c).toLowerCase().includes(clientSearch.trim().toLowerCase()))
    .slice(0, 4);
  function pickClient(c) {
    setSelectedClientId(c.id);
    setClientSearch(clientLabel(c));
    setClientDropdownOpen(false);
  }

  // Discipline-specific assessments (Speech-Language/Occupational) require
  // picking a therapist of that discipline, right below Client, before a
  // time slot can be chosen.
  const [therapists, setTherapists] = useState([]);
  const [selectedTherapist, setSelectedTherapist] = useState('');
  useEffect(() => {
    if (!requiredRole) return;
    let cancelled = false;
    api('/shifts').then(data => { if (!cancelled) setTherapists(data || []); }).catch(() => { if (!cancelled) setTherapists([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredRole]);
  // A discipline-specific assessment is a follow-up for a client already in
  // that program, so the only valid therapist is the one they're actually
  // assigned to, not just anyone of that discipline on shift, picking a
  // different therapist would silently reassign the client's care.
  const selectedClient = bookableClients.find(cl => cl.id === selectedClientId);
  const eligibleTherapists = selectedClient?.assigned_therapist_name
    ? therapists.filter(t => t.name === selectedClient.assigned_therapist_name
        && t.role === requiredRole && therapistWorksOn(t, selected.date))
    : [];

  // Auto-select the client's own assigned therapist, it's the only option,
  // there's nothing for staff to actually choose between.
  useEffect(() => {
    if (!requiredRole) return;
    setSelectedTherapist(eligibleTherapists.length === 1 ? eligibleTherapists[0].name : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, therapists]);

  // Once a client (or, for assessments, a therapist) is picked, re-fetch slots
  // scoped to that specific therapist's shift so Start Time only shows hours
  // they're actually available, instead of the whole clinic's combined capacity.
  const [scopedSlots, setScopedSlots] = useState(daySlots);
  useEffect(() => {
    const therapistParam = requiredRole ? selectedTherapist : '';
    const clientParam = !requiredRole ? selectedClientId : '';
    if (!therapistParam && !clientParam) { setScopedSlots(daySlots); return; }
    let cancelled = false;
    const qs = therapistParam ? '&therapist_name=' + encodeURIComponent(therapistParam) : '&client_id=' + clientParam;
    api('/reservations/slots?date=' + selected.date + qs)
      .then(data => { if (!cancelled) setScopedSlots(data); })
      .catch(() => { if (!cancelled) setScopedSlots(daySlots); });
    return () => { cancelled = true; };
  }, [selectedClientId, selectedTherapist, requiredRole, selected.date, daySlots]);

  useEffect(() => {
    const amt = document.getElementById('modal-amount');
    if (amt && serviceType) amt.value = rateForSessionType(serviceType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timeFieldsLocked = requiredRole && !selectedTherapist;

  return (
    <Modal title={'Book Slot: ' + selected.label + ', ' + selected.year} onClose={onClose} width={540}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9, background: '#F0F9FF', border: '1px solid #BAE6FD', marginBottom: 16 }}>
        <i className="fa-solid fa-clipboard-check" style={{ color: '#0EA5E9', fontSize: 16 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{serviceType}</div>
          <div style={{ fontSize: 11.5, color: '#64748B' }}>{selected.label}, {selected.year}{time ? ' · Time slot: ' + time : ''}</div>
        </div>
      </div>
      <div id="bk-err" style={{ display: 'none', background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, fontWeight: 600, marginBottom: 14 }}>
        <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} /><span id="bk-err-msg" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1/-1', position: 'relative' }}>
          <label className="form-label">Client *</label>
          <input
            className="form-input"
            id="modal-client-select"
            autoComplete="off"
            placeholder="Type a name or client code…"
            value={clientSearch}
            onChange={e => {
              setClientSearch(e.target.value);
              setSelectedClientId('');
              setClientDropdownOpen(true);
            }}
            onFocus={() => setClientDropdownOpen(true)}
            onBlur={() => setClientDropdownOpen(false)}
          />
          {clientDropdownOpen && (
            <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, boxShadow: '0 8px 20px rgba(15,23,42,.1)', overflow: 'hidden' }}>
              {clientMatches.length ? clientMatches.map(c => (
                <div
                  key={c.id}
                  // onMouseDown (not onClick) fires before the input's onBlur closes the dropdown.
                  onMouseDown={e => { e.preventDefault(); pickClient(c); }}
                  style={{ padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', borderBottom: '1px solid #F1F5F9' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#F0F9FF'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                >
                  {clientLabel(c)}
                </div>
              )) : (
                <div style={{ padding: '8px 12px', fontSize: 12.5, color: '#94A3B8' }}>No matching clients</div>
              )}
            </div>
          )}
          {isInitialAssessment && !bookableClients.length && (
            <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />Every client already has a therapy type and therapist assigned, none are eligible for an Initial Assessment.</div>
          )}
          {requiredDiscipline && !bookableClients.length && (
            <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />No clients are designated for {requiredDiscipline === 'Speech' ? 'Speech-Language' : 'Occupational'} Therapy yet.</div>
          )}
          {(() => {
            const c = bookableClients.find(cl => cl.id === selectedClientId);
            return (!requiredRole && c?.assigned_therapist_name)
              ? <div style={{ fontSize: 11.5, color: '#0EA5E9', marginTop: 5 }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Showing available times for {c.assigned_therapist_name}'s schedule only.</div>
              : null;
          })()}
        </div>
        {requiredRole && (
          <div style={{ gridColumn: '1/-1' }}>
            <label className="form-label">{requiredRole === 'speech' ? 'Speech-Language Therapist *' : 'Occupational Therapist *'}</label>
            <select className="form-select" id="modal-therapist-select" value={selectedTherapist} onChange={e => setSelectedTherapist(e.target.value)} disabled={eligibleTherapists.length <= 1}>
              <option value="">- Select therapist -</option>
              {eligibleTherapists.map(t => <option key={t.therapist_id} value={t.name}>{t.name}</option>)}
            </select>
            {!selectedClientId && (
              <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 5 }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Select a client first.</div>
            )}
            {selectedClientId && !selectedClient?.assigned_therapist_name && (
              <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />{selectedClient?.full_name || 'This client'} doesn't have an assigned therapist yet.</div>
            )}
            {selectedClientId && selectedClient?.assigned_therapist_name && !eligibleTherapists.length && (
              <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 5 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />{selectedClient.assigned_therapist_name} is not on shift on {selected.label}.</div>
            )}
          </div>
        )}
        <fieldset disabled={timeFieldsLocked} style={{ display: 'contents', border: 0, margin: 0, padding: 0 }}>
        <div>
          <label className="form-label">Session Date</label>
          <input className="form-input" type="date" value={selected.date} readOnly style={{ background: '#F1F5F9', fontWeight: 600 }} />
        </div>
        <div>
          <label className="form-label">Start Time *</label>
          <select className="form-select" id="modal-time-select" defaultValue={defaultTime}>
            {scopedSlots.map(s => {
              const t = s.time_slot;
              const avail = effectiveSlotAvailable(s, serviceType);
              const full = avail <= 0;
              const st = slotState(t);
              const dead = full || st !== 'future';
              const isInitialAssessment = serviceType === 'Initial Assessment';
              const suffix = s.lunch_break ? ', lunch break' : full ? ', fully booked' : (st === 'ended' ? ', ended' : (st === 'ongoing' ? ', ongoing now' : (isInitialAssessment ? ', 1 slot per hour' : (s.capacity > 1 ? `, ${avail} of ${s.capacity} free` : ''))));
              return <option key={t} value={t} disabled={dead}>{t}{suffix}</option>;
            })}
          </select>
        </div>
        <div>
          <label className="form-label">Payment Amount (₱) *</label>
          <input className="form-input" type="number" min="1" step="1" id="modal-amount" placeholder="e.g. 1400" />
        </div>
        <div style={{ gridColumn: '1/-1' }}>
          <label className="form-label">Notes (optional)</label>
          <input className="form-input" id="modal-notes" placeholder="e.g. Parent requested morning slot only" />
        </div>
        </fieldset>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={onConfirm} disabled={busy}><i className="fa-solid fa-calendar-check" style={{ marginRight: 5 }} />{busy ? 'Booking…' : 'Confirm Booking'}</button>
      </div>
    </Modal>
  );
}

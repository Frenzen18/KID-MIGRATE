import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';

const DOMAIN_OPTIONS = ['Fine Motor', 'Gross Motor', 'Sensory Processing', 'Self-Care / ADL', 'Articulation', 'Receptive Language', 'Expressive Language', 'Pragmatics / Social Communication'];

export default function LogProgressNoteModal({ data, closeModal }) {
  const today = new Date().toISOString().slice(0, 10);
  const [sessionDate, setSessionDate] = useState(today);
  const [domain, setDomain] = useState('');
  const [score, setScore] = useState('');
  const [attended, setAttended] = useState(true);
  const [remark, setRemark] = useState('');
  const [nextPlan, setNextPlan] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    if (!domain.trim()) return setErr('Domain is required.');
    const scoreNum = Number(score);
    if (score === '' || isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100) return setErr('Score must be a number between 0 and 100.');
    if (sessionDate > today) return setErr('Session date cannot be in the future, a progress note records a session that already happened.');
    setSaving(true);
    try {
      await data.onSave({
        session_date: sessionDate, domain: domain.trim(), score: scoreNum, attended,
        remark: remark.trim(), next_plan: nextPlan.trim(),
        tags: tags.split(',').map(t => t.trim()).filter(Boolean)
      });
      closeModal();
    } catch (e) {
      setErr(e.message || 'Failed to log progress note');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={<><i className="fa-solid fa-notes-medical" style={{ color: '#10B981', marginRight: 8 }} />Log Progress Note{data.childName ? ': ' + data.childName : ''}</>} onClose={closeModal} width={480}>
      {err && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, color: '#C4302B', marginBottom: 14, fontWeight: 600 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label className="form-label">Session Date *</label><input className="form-input" type="date" max={today} value={sessionDate} onChange={e => setSessionDate(e.target.value)} /></div>
        <div><label className="form-label">Attendance *</label><select className="form-select" value={attended ? 'yes' : 'no'} onChange={e => setAttended(e.target.value === 'yes')}><option value="yes">✅ Attended</option><option value="no">❌ Missed</option></select></div>
        <div><label className="form-label">Domain *</label><input className="form-input" list="progress-domain-options" value={domain} onChange={e => setDomain(e.target.value)} placeholder="e.g. Fine Motor" /><datalist id="progress-domain-options">{DOMAIN_OPTIONS.map(d => <option key={d} value={d} />)}</datalist></div>
        <div><label className="form-label">Score (0–100) *</label><input className="form-input" type="number" min="0" max="100" value={score} onChange={e => setScore(e.target.value)} placeholder="e.g. 72" /></div>
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Remarks</label><textarea className="form-input" rows="2" style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }} value={remark} onChange={e => setRemark(e.target.value)} placeholder="Clinical observations for this session…" /></div>
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Next Plan</label><input className="form-input" value={nextPlan} onChange={e => setNextPlan(e.target.value)} placeholder="Focus for the next session…" /></div>
        <div style={{ gridColumn: '1/-1' }}><label className="form-label">Tags <span style={{ fontWeight: 400, color: '#94A3B8' }}>(comma-separated)</span></label><input className="form-input" value={tags} onChange={e => setTags(e.target.value)} placeholder="e.g. improved grip, needs cueing" /></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button className="btn-secondary" onClick={closeModal} disabled={saving}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={saving}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />{saving ? 'Saving…' : 'Save Note'}</button>
      </div>
    </Modal>
  );
}

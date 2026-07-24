import { useState, useEffect } from 'react';
import { Modal } from '../../../../components/ui.jsx';
import { api } from '../../../../api.js';
import GasProgressChart from '../../../../components/GasProgressChart.jsx';
import ProgressChart from '../../../../components/ProgressChart.jsx';
import { formatPhoneDisplay } from '../../../../phoneInput.js';

/* 3-stage Scorecard workflow (Before / During / After Session), opened by
   clicking a client in a therapist's Client Records instead of navigating to
   Milestones and picking from a dropdown, adapted from that page's inline GAS
   wizard (client/therapist/discipline are already fixed here, so those pickers
   are gone, everything else, mood/parent observation/sliders/summary/submit,
   matches it field for field). */

const STEPS = [
  { n: 1, label: 'Before Session', icon: 'fa-clipboard-list' },
  { n: 2, label: 'During Session', icon: 'fa-wave-square' },
  { n: 3, label: 'After Assessment', icon: 'fa-file-signature' }
];
const GAS_LEVEL_FIELD = { '-2': 'level_m2', '-1': 'level_m1', '0': 'level_0', '1': 'level_p1', '2': 'level_p2' };

function todayStr() { return new Date().toISOString().split('T')[0]; }

function relativeSavedLabel(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return diffMin + ' min ago';
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return diffHr + ' hr ago';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Kiresuk & Sherman GAS T-score; rho = 0.3. Mirrors server/routes/gas.js and Milestones.jsx. */
function computeGasTScore(scored) {
  const RHO = 0.3;
  let sumWX = 0, sumW = 0, sumW2 = 0;
  for (const s of scored) {
    sumWX += s.weight * s.level;
    sumW += s.weight;
    sumW2 += s.weight * s.weight;
  }
  const denom = Math.sqrt((1 - RHO) * sumW2 + RHO * sumW * sumW);
  if (!denom) return 50;
  return Math.round((50 + (10 * sumWX) / denom) * 10) / 10;
}

export default function ScorecardWizardModal({ client, therapistName, discipline, onClose, toast, onSubmitted }) {
  const [step, setStep] = useState(1);
  const [sessionDate, setSessionDate] = useState(todayStr());
  const [parentObservation, setParentObservation] = useState('');
  const [remarks, setRemarks] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [scores, setScores] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [recordExpanded, setRecordExpanded] = useState(null);

  // Draft autosave, local to this browser, one draft per client+discipline. Never
  // submitted server-side, so an interrupted session (or one that just needs to
  // be picked up again later) isn't lost, purely a therapist convenience.
  const draftKey = 'kid_gas_draft_' + client.id + '_' + discipline;
  const [pendingDraft, setPendingDraft] = useState(null); // a draft found on mount, not yet applied
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) setPendingDraft(JSON.parse(raw));
    } catch { /* corrupt/old draft, ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveDraft() {
    const draft = { step, sessionDate, parentObservation, remarks, summaryDraft, scores, savedAt: new Date().toISOString() };
    localStorage.setItem(draftKey, JSON.stringify(draft));
    setDraftSavedAt(draft.savedAt);
    toast('Draft saved', 'fa-floppy-disk');
  }

  function resumeDraft() {
    if (!pendingDraft) return;
    setStep(pendingDraft.step || 1);
    setSessionDate(pendingDraft.sessionDate || todayStr());
    setParentObservation(pendingDraft.parentObservation || '');
    setRemarks(pendingDraft.remarks || '');
    setSummaryDraft(pendingDraft.summaryDraft || '');
    setScores(pendingDraft.scores || {});
    setDraftSavedAt(pendingDraft.savedAt || null);
    setPendingDraft(null);
  }

  function discardDraft() {
    localStorage.removeItem(draftKey);
    setPendingDraft(null);
  }

  const [clientRecord, setClientRecord] = useState(null);
  const [clientRecordLoading, setClientRecordLoading] = useState(true);
  function fetchClientRecord() {
    setClientRecordLoading(true);
    return api('/clients/' + client.id).then(setClientRecord).catch(() => setClientRecord(null)).finally(() => setClientRecordLoading(false));
  }
  useEffect(() => { fetchClientRecord(); }, [client.id]);

  const [progress, setProgress] = useState(null);
  const [progressLoading, setProgressLoading] = useState(true);
  useEffect(() => {
    api('/analytics/progress/' + client.id).then(setProgress).catch(() => setProgress(null)).finally(() => setProgressLoading(false));
  }, [client.id]);

  const [devFields, setDevFields] = useState([]);
  useEffect(() => { api('/dev-functional-fields').then(setDevFields).catch(() => setDevFields([])); }, []);

  const attendanceByMonth = (() => {
    const rows = progress?.attendance || [];
    if (!rows.length) return [];
    const buckets = {};
    for (const r of rows) {
      const d = new Date(r.session_date + 'T00:00:00');
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      if (!buckets[key]) buckets[key] = { label, a: 0, m: 0 };
      if (r.attended) buckets[key].a++; else buckets[key].m++;
    }
    return Object.keys(buckets).sort().map(k => buckets[k]);
  })();

  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '–';
  const field = (label, value) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 9.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 1 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: '#0F172A', fontWeight: 500 }}>{value}</div>
    </div>
  );

  const [gasSet, setGasSet] = useState(null);
  const [gasSetLoading, setGasSetLoading] = useState(true);
  useEffect(() => {
    setGasSetLoading(true);
    api('/gas/questionnaires?discipline=' + encodeURIComponent(discipline))
      .then(sets => setGasSet(sets.find(s => s.status === 'active') || sets[0] || null))
      .catch(() => setGasSet(null))
      .finally(() => setGasSetLoading(false));
  }, [discipline]);

  const items = gasSet?.items || [];
  // Every goal defaults to level 0 (expected outcome) as soon as the set loads, a
  // slider needs a starting position, unlike a click-to-score button row.
  useEffect(() => {
    if (!items.length) return;
    setScores(prev => {
      let changed = false;
      const next = { ...prev };
      for (const it of items) if (next[it.id] === undefined) { next[it.id] = 0; changed = true; }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const scoredCount = items.filter(it => scores[it.id] !== undefined).length;
  const previewScore = scoredCount
    ? computeGasTScore(items.filter(it => scores[it.id] !== undefined).map(it => ({ weight: Number(it.weight) || 1, level: scores[it.id] })))
    : null;

  function nextStep() { setStep(s => Math.min(3, s + 1)); }
  function prevStep() { setStep(s => Math.max(1, s - 1)); }

  async function generateSummary() {
    setSummaryLoading(true);
    try {
      const scoredGoals = items.filter(it => scores[it.id] !== undefined).map(it => ({
        item_title: it.title,
        weight: Number(it.weight) || 1,
        level: scores[it.id],
        level_label: it[GAS_LEVEL_FIELD[String(scores[it.id])]]
      }));
      const result = await api('/gas/ai-summary', {
        method: 'POST',
        body: {
          clientName: client.full_name,
          clientCode: client.client_code,
          discipline, sessionDate, therapistName,
          tScore: previewScore,
          goals: scoredGoals,
          parentObservation, remarks
        }
      });
      const sections = [];
      if (previewScore != null || result.overallSummary) {
        const scoreLine = previewScore != null ? `Overall GAS T-Score: ${previewScore}` : '';
        sections.push([scoreLine, result.overallSummary].filter(Boolean).join('\n'));
      }
      if (result.goalProgress?.length) {
        sections.push(['Goal Progress:', ...result.goalProgress.map(g => `- ${g.goal}: ${g.result}`)].join('\n'));
      }
      if (result.parentObservationNote) {
        sections.push(`Parent Observation:\n${result.parentObservationNote}`);
      }
      if (result.therapistRemarksNote) {
        sections.push(`Plans, Analysis, and Instructions:\n${result.therapistRemarksNote}`);
      }
      setSummaryDraft(sections.join('\n\n'));
    } catch (e) {
      toast(e.message || 'Failed to generate AI summary', 'fa-triangle-exclamation');
    } finally {
      setSummaryLoading(false);
    }
  }

  async function submitEntry() {
    if (!sessionDate) { toast('Select a session date', 'fa-triangle-exclamation'); return; }
    if (sessionDate > todayStr()) { toast('Session date cannot be in the future', 'fa-triangle-exclamation'); return; }
    if (!gasSet) { toast('No active questionnaire set for this discipline yet', 'fa-triangle-exclamation'); return; }
    if (scoredCount !== items.length) { toast('Score every goal before submitting', 'fa-triangle-exclamation'); return; }

    const remarksParts = [];
    if (parentObservation.trim()) remarksParts.push(`Parent observation: ${parentObservation.trim()}`);
    if (summaryDraft.trim()) remarksParts.push(summaryDraft.trim());
    else if (remarks.trim()) remarksParts.push(remarks.trim());
    const combinedRemarks = remarksParts.join('\n\n');

    setSubmitting(true);
    try {
      const entry = await api('/gas/entries', {
        method: 'POST',
        body: {
          client_id: client.id, questionnaire_id: gasSet.id,
          session_date: sessionDate, therapist_name: therapistName, remarks: combinedRemarks,
          scores: items.map(it => ({ item_id: it.id, level: scores[it.id] }))
        }
      });
      localStorage.removeItem(draftKey);
      toast('GAS entry submitted, T-score ' + entry.gas_t_score, 'fa-clipboard-check');
      onSubmitted?.(entry);
      onClose();
    } catch (e) {
      toast(e.message || 'Failed to submit GAS entry', 'fa-triangle-exclamation');
    } finally {
      setSubmitting(false);
    }
  }

  const initials = (client.full_name || client.name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  return (
      <Modal title={`Scorecard: ${client.full_name || client.name}`} onClose={onClose} width={900}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #F1F5F9' }}>
          {client.photo_url ? (
            <img src={client.photo_url} alt={client.full_name || client.name} style={{ width: 38, height: 38, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
          ) : (
            <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#0EA5E9,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#fff', flexShrink: 0 }}>{initials}</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{client.full_name || client.name}</div>
            <div style={{ fontSize: 11.5, color: '#64748B' }}>{discipline}</div>
          </div>
        </div>

        {/* Step stepper */}
        {pendingDraft && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 10, border: '1px solid #BFDBFE', background: '#EFF6FF', marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, color: '#1E40AF' }}>
              <i className="fa-solid fa-clock-rotate-left" style={{ marginRight: 7 }} />
              You have a saved draft from {relativeSavedLabel(pendingDraft.savedAt)}.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={discardDraft}>Discard</button>
              <button className="btn-primary" style={{ padding: '5px 12px', fontSize: 11.5 }} onClick={resumeDraft}>Resume Draft</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
          <div className="gas-stepper">
            {STEPS.map((s, i) => (
              <span key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={'gas-step-pill' + (step === s.n ? ' current' : step > s.n ? ' done' : '')} onClick={() => setStep(s.n)}>
                  <span className="num">{step > s.n ? <i className="fa-solid fa-check" /> : s.n}</span>
                  Step {s.n}: {s.label}
                </span>
                {i < STEPS.length - 1 && <i className="fa-solid fa-angle-right gas-step-arrow" />}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {draftSavedAt && <span style={{ fontSize: 10.5, color: '#94A3B8' }}>Draft saved {relativeSavedLabel(draftSavedAt)}</span>}
            <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 11.5 }} onClick={saveDraft}>
              <i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />Save Draft
            </button>
          </div>
        </div>

        {/* ── Step 1: Before Session ── */}
        {step === 1 && (
          <div className="gas-two-col">
            <div>
              <div style={{ marginBottom: 14 }}>
                <label className="form-label">Session Date *</label>
                <input className="form-input" type="date" max={todayStr()} value={sessionDate} onChange={e => setSessionDate(e.target.value)} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label className="form-label">Therapist</label>
                <input className="form-input" value={therapistName} disabled />
              </div>


              <div>
                <label className="form-label">Parent Observation</label>
                <textarea className="form-input" rows="4" style={{ height: 'auto', padding: '10px 12px', resize: 'vertical' }}
                  placeholder="Parent observation text notes…" value={parentObservation} onChange={e => setParentObservation(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="form-label">Client Records</label>
              {clientRecordLoading ? (
                <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '30px 0', textAlign: 'center' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading records…</div>
              ) : (
                <div style={{ maxHeight: 440, overflowY: 'auto', paddingRight: 2 }}>
                  {[
                    {
                      key: 'personal', label: 'Personal Information', icon: 'fa-id-card',
                      body: (
                        <>
                          {field('Date of Birth', fmtDate(clientRecord?.dob))}
                          {field('Enrolled Since', fmtDate(clientRecord?.created_at))}
                          {field('Guardian', clientRecord?.guardian_name || '–')}
                          {field('Contact', clientRecord?.guardian_contact ? formatPhoneDisplay(clientRecord.guardian_contact) : '–')}
                        </>
                      )
                    },
                    {
                      key: 'medical', label: 'Medical Information', icon: 'fa-notes-medical',
                      body: (
                        <>
                          {field('Allergies', clientRecord?.allergies || 'None recorded')}
                          {field('Medications', clientRecord?.daily_medication || 'None recorded')}
                          {field('Emergency Contact', clientRecord?.guardian_name || '–')}
                        </>
                      )
                    },
                    {
                      key: 'dev', label: 'Development & Functional Information', icon: 'fa-child-reaching',
                      body: devFields.length === 0
                        ? <div style={{ fontSize: 12, color: '#94A3B8' }}>No fields configured yet.</div>
                        : devFields.map(f => <span key={f.id}>{field(f.label, (clientRecord?.dev_functional_data || {})[f.id] || 'Not recorded')}</span>)
                    },
                    {
                      key: 'progress', label: 'Client Progress', icon: 'fa-chart-area',
                      body: progressLoading ? (
                        <div style={{ fontSize: 12, color: '#94A3B8', padding: '10px 0' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading…</div>
                      ) : progress && Object.keys(progress.domains || {}).length > 0 ? (
                        <>
                          <ProgressChart domains={progress.domains} />
                          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #F1F5F9' }}>
                            <div style={{ display: 'flex', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 10.5, color: '#475569', fontWeight: 600 }}><i className="fa-solid fa-circle-check" style={{ color: '#10B981', marginRight: 3 }} />{progress.attended} attended</span>
                              <span style={{ fontSize: 10.5, color: '#475569', fontWeight: 600 }}><i className="fa-solid fa-circle-xmark" style={{ color: '#EF4444', marginRight: 3 }} />{progress.missed} missed</span>
                            </div>
                            {attendanceByMonth.slice(-3).map(({ label, a, m }) => { const total = a + m; return (<div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}><span style={{ width: 46, fontSize: 9.5, color: '#64748B', fontWeight: 600 }}>{label}</span><div style={{ flex: 1, height: 5, background: (m ? '#FEE2E2' : '#F1F5F9'), borderRadius: 3, overflow: 'hidden' }}><div style={{ width: Math.round(a / total * 100) + '%', height: '100%', background: '#10B981' }} /></div><span style={{ fontSize: 9.5, color: '#475569', fontWeight: 600, width: 32, textAlign: 'right' }}>{a}/{total}</span></div>); })}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 12, color: '#94A3B8', padding: '10px 0' }}>No session notes recorded yet.</div>
                      )
                    },
                    {
                      key: 'gas', label: 'GAS Longitudinal Progress', icon: 'fa-chart-line',
                      body: <GasProgressChart entries={clientRecord?.gas_entries || []} />
                    }
                  ].map(row => (
                    <div key={row.key} className="gas-record-row" onClick={() => setRecordExpanded(x => x === row.key ? null : row.key)} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span><i className={'fa-solid ' + row.icon} style={{ marginRight: 6, color: '#94A3B8', fontSize: 11 }} />{row.label}</span>
                        <i className={'fa-solid ' + (recordExpanded === row.key ? 'fa-chevron-up' : 'fa-chevron-down')} style={{ fontSize: 10, color: '#94A3B8' }} />
                      </div>
                      {recordExpanded === row.key && <div className="body">{row.body}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ gridColumn: '1/-1', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-primary" onClick={nextStep}>Next <i className="fa-solid fa-angle-right" style={{ marginLeft: 6 }} /></button>
            </div>
          </div>
        )}

        {/* ── Step 2: During Session ── */}
        {step === 2 && (
          <div>
            <div style={{ marginBottom: 18 }}>
              <label className="form-label" style={{ marginBottom: 10, display: 'block' }}>GAS Assessment Questionnaire</label>
              {gasSetLoading ? (
                <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '20px 0' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading goals…</div>
              ) : !gasSet ? (
                <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '20px 0' }}>No active GAS questionnaire configured for {discipline} yet, contact an administrator.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 560, overflowY: 'auto', paddingRight: 4 }}>
                  {items.map(it => {
                    const lvl = scores[it.id] ?? 0;
                    return (
                      <div key={it.id} style={{ padding: 12, borderRadius: 10, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Goal: {it.title}</div>
                          <span style={{ fontSize: 10.5, color: '#94A3B8', whiteSpace: 'nowrap' }}>weight ×{it.weight}</span>
                        </div>
                        {it.description && <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 4 }}>{it.description}</div>}
                        <input type="range" min={-2} max={2} step={1} value={lvl} className="gas-goal-slider"
                          onChange={e => setScores(prev => ({ ...prev, [it.id]: Number(e.target.value) }))} />
                        <div className="gas-slider-scale">
                          <span>[-2]</span><span>-1</span><span>0</span><span>+1</span><span>[+2]</span>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11.5, color: '#334155', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 7, padding: '6px 9px' }}>
                          {it[GAS_LEVEL_FIELD[String(lvl)]]}
                        </div>
                      </div>
                    );
                  })}
                  {!items.length && <div style={{ fontSize: 12.5, color: '#94A3B8' }}>This questionnaire set has no goals yet, contact an administrator.</div>}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 18 }}>
              <label className="form-label">GAS Score Trend (Inputted on Scale)</label>
              <div style={{ padding: 12, borderRadius: 10, background: '#F5F3FF', border: '1px solid #DDD6FE', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, color: '#4F46E5', fontWeight: 600 }}>Live GAS T-Score Preview</span>
                <span style={{ fontSize: 20, fontWeight: 700, color: '#4F46E5' }}>{previewScore ?? '-'}</span>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button className="btn-secondary" onClick={prevStep}><i className="fa-solid fa-angle-left" style={{ marginRight: 6 }} />Back</button>
              <button className="btn-primary" onClick={nextStep}>Next <i className="fa-solid fa-angle-right" style={{ marginLeft: 6 }} /></button>
            </div>
          </div>
        )}

        {/* ── Step 3: After Assessment ── */}
        {step === 3 && (
          <div className="gas-two-col">
            <div>
              <label className="form-label">Remarks: Plans, Analysis, and Instructions</label>
              <textarea className="form-input" rows="10" style={{ height: 'auto', padding: '10px 12px', resize: 'vertical', marginBottom: 12 }}
                placeholder="Remarks: Plans, Analysis, and Instructions" value={remarks} onChange={e => setRemarks(e.target.value)} />
              <button className="btn-secondary" style={{ width: '100%' }} disabled={summaryLoading} onClick={generateSummary}>
                <i className={'fa-solid ' + (summaryLoading ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles')} style={{ marginRight: 6 }} />
                {summaryLoading ? 'Generating…' : 'Generate Summary'}
              </button>
            </div>

            <div>
              <label className="form-label">Summary Preview</label>
              <textarea className="form-input" rows="10" style={{ height: 'auto', padding: '10px 12px', resize: 'vertical', marginBottom: 12 }}
                placeholder='Click "Generate Summary" to draft a note from Sections 1–3, then edit as needed…'
                value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)} />
              <button className="btn-primary" style={{ width: '100%' }} disabled={submitting} onClick={submitEntry}>
                <i className="fa-solid fa-paper-plane" style={{ marginRight: 6 }} />{submitting ? 'Submitting…' : 'Submit Session'}
              </button>
              <div style={{ marginTop: 10, fontSize: 12, color: '#64748B', textAlign: 'right' }}>{scoredCount} / {items.length} goals scored</div>
            </div>

            <div style={{ gridColumn: '1/-1' }}>
              <button className="btn-secondary" onClick={prevStep}><i className="fa-solid fa-angle-left" style={{ marginRight: 6 }} />Back</button>
            </div>
          </div>
        )}
      </Modal>
  );
}

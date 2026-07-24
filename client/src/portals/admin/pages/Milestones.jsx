import { useState, useEffect } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { api } from '../../../api.js';
import { useAuth } from '../../../auth.jsx';
import NewSessionEntryModal from './milestones/NewSessionEntryModal.jsx';
import ScorecardWizardModal from './milestones/ScorecardWizardModal.jsx';

/* == page: milestones == */

/* ── GAS (Goal Attainment Scaling) assessment questionnaire tool ── */
const GAS_DISCIPLINES = ['Speech-Language Therapy', 'Occupational Therapy'];
const ROLE_DISCIPLINE = { ot: 'Occupational Therapy', speech: 'Speech-Language Therapy' };
// clients.therapy_type is stored as the short code ('OT' / 'Speech' / 'Both'), not
// the full discipline name used here and by GAS questionnaires, this maps between them.
const DISCIPLINE_THERAPY_CODE = { 'Speech-Language Therapy': 'Speech', 'Occupational Therapy': 'OT' };
const GAS_LEVEL_FIELD = { '-2': 'level_m2', '-1': 'level_m1', '0': 'level_0', '1': 'level_p1', '2': 'level_p2' };
const emptyGasItemDraft = () => ({ title: '', description: '', level_m2: '', level_m1: '', level_0: '', level_p1: '', level_p2: '', weight: 1 });

/* ── 3-stage scorecard workflow (Before / During / After), shared by both
   OT and Speech-Language disciplines since it lives inside the same
   discipline-scoped section as the rest of the GAS tool below. ── */
const GAS_STEPS = [
  { n: 1, label: 'Before Session', icon: 'fa-clipboard-list' },
  { n: 2, label: 'During Session', icon: 'fa-wave-square' },
  { n: 3, label: 'After Assessment', icon: 'fa-file-signature' }
];

/** A GAS entry scores a session that already happened, so its date can never be in the future. */
function todayStr() { return new Date().toISOString().split('T')[0]; }

/** Kiresuk & Sherman GAS T-score; rho = 0.3 (standard assumed average intercorrelation among goal scales). Mirrors server/routes/gas.js. */
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
// Parent observation is folded into the stored remarks text as its own leading
// paragraph on submit (see submitEntry), split it back out to show/edit it as its own field.
function splitGasRemarks(remarks) {
  const paragraphs = (remarks || '').split('\n\n');
  const parentIdx = paragraphs.findIndex(p => p.startsWith('Parent observation: '));
  const parentObservation = parentIdx !== -1 ? paragraphs[parentIdx].slice('Parent observation: '.length) : '';
  const rest = paragraphs.filter((_, i) => i !== parentIdx).join('\n\n');
  return { parentObservation, remarks: rest };
}
function gasScoreTone(score) {
  if (score == null) return 'gray';
  if (score >= 60) return 'green';
  if (score >= 45) return 'blue';
  if (score >= 35) return 'amber';
  return 'red';
}

const MILESTONES_TAB_KEYS = ['scorecard', 'entries'];

export default function Milestones({ go, toast, openModal }) {
  /* ── Tab switching ── */
  const [tab, setTab] = useState(() => {
    const saved = localStorage.getItem('kid_admin_milestones_tab');
    return MILESTONES_TAB_KEYS.includes(saved) ? saved : 'scorecard';
  });
  useEffect(() => { localStorage.setItem('kid_admin_milestones_tab', tab); }, [tab]);

  /* ── Page-local modals ── */
  const [msModal, setMsModal] = useState(null); // { type, param, name, lockDate }
  const openMsModal = (type, param) => setMsModal({ type, param });
  const closeModal = () => setMsModal(null);

  /* ═══════ GAS (Goal Attainment Scaling) assessment questionnaire tool ═══════ */
  const { user } = useAuth();
  const isGasAdmin = user?.role === 'admin';
  // An 'ot'/'speech' account only ever scores their own discipline, role directly
  // encodes it now. Admin/staff are unrestricted and see both disciplines.
  const lockedDiscipline = ROLE_DISCIPLINE[user?.role] || null;
  const visibleDisciplines = lockedDiscipline ? [lockedDiscipline] : GAS_DISCIPLINES;

  const [gasDiscipline, setGasDiscipline] = useState(GAS_DISCIPLINES[0]);
  const [gasSets, setGasSets] = useState({});       // { [discipline]: [{...set, items:[]}] }
  const [gasSetId, setGasSetId] = useState({});     // { [discipline]: selected questionnaire id }
  const [gasEntries, setGasEntries] = useState({}); // { [discipline]: [entry] }
  const [gasClients, setGasClients] = useState([]);
  const [gasTherapists, setGasTherapists] = useState([]); // [{ therapist_id, name }], registered role: therapist accounts
  const [gasLoading, setGasLoading] = useState(false);
  // Real caseload for a locked ot/speech account: distinct client_ids from their own
  // non-cancelled reservation history, same "assigned = real history" rule used for
  // Client Records, so a therapist can only score/browse children actually theirs.
  const [gasAssignedClientIds, setGasAssignedClientIds] = useState(new Set());
  const [gasAssignedClientsLoading, setGasAssignedClientsLoading] = useState(false);

  useEffect(() => {
    if (!lockedDiscipline || !user?.name) return;
    setGasAssignedClientsLoading(true);
    Promise.all([
      api('/reservations?therapist_name=' + encodeURIComponent(user.name)),
      api('/clients')
    ])
      .then(([rows, clients]) => {
        const ids = new Set((rows || []).filter(r => !['cancelled', 'declined'].includes(r.status)).map(r => r.client_id));
        // Plus any child an admin/staff explicitly assigned to this therapist via
        // Edit Client Profile, even before a first real session was booked. A locked
        // account's own role is directly 'ot'/'speech', so it maps straight onto
        // that client's own discipline-specific assigned-therapist field.
        const assignedField = user.role === 'speech' ? 'assigned_speech_therapist_name' : 'assigned_ot_therapist_name';
        for (const c of clients || []) if (c[assignedField] === user.name) ids.add(c.id);
        setGasAssignedClientIds(ids);
        if (!gasClients.length) setGasClients(clients || []);
      })
      .catch(() => setGasAssignedClientIds(new Set()))
      .finally(() => setGasAssignedClientsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedDiscipline, user?.name]);

  const [gasForm, setGasForm] = useState({ client_id: '', session_date: todayStr(), therapist_name: '', remarks: '' });
  const [gasScores, setGasScores] = useState({}); // { [item_id]: level }
  const [gasSubmitting, setGasSubmitting] = useState(false);

  // ── 3-stage workflow state (Before Session / During Session / After Assessment) ──
  const [gasStep, setGasStep] = useState(1);
  const [gasParentObservation, setGasParentObservation] = useState('');
  const [gasSummaryDraft, setGasSummaryDraft] = useState('');
  // Full profile (with session_notes/attendance/gas_entries) for the child selected in
  // Step 1's Client Records panel, mirrors Clients.jsx's own client-detail fetch.
  const [gasClientRecord, setGasClientRecord] = useState(null);
  const [gasClientRecordLoading, setGasClientRecordLoading] = useState(false);

  useEffect(() => {
    if (!gasForm.client_id) { setGasClientRecord(null); return; }
    setGasClientRecordLoading(true);
    api('/clients/' + gasForm.client_id)
      .then(setGasClientRecord)
      .catch(() => setGasClientRecord(null))
      .finally(() => setGasClientRecordLoading(false));
  }, [gasForm.client_id]);

  function gasGoToStep(n) { setGasStep(n); }

  function gasNextStep() {
    if (gasStep === 1 && !gasForm.client_id) { toast('Select a child before continuing', 'fa-triangle-exclamation'); return; }
    setGasStep(s => Math.min(3, s + 1));
  }
  function gasPrevStep() { setGasStep(s => Math.max(1, s - 1)); }

  // Searchable client combobox for Step 1 (text query + dropdown list, mirrors the
  // therapist search combobox pattern already used below).
  const [gasClientQuery, setGasClientQuery] = useState('');
  const [gasClientOpen, setGasClientOpen] = useState(false);

  function selectGasClientOption(c) {
    setGasForm(f => ({ ...f, client_id: c.id }));
    setGasClientQuery(c.full_name);
    setGasClientOpen(false);
  }

  const [gasRecordExpanded, setGasRecordExpanded] = useState(null); // which Client Records row is expanded

  // Discipline-locked (ot/speech) Scorecard tab shows a client picker first,
  // like Client Records, clicking a child opens the 3-step wizard modal for
  // them, rather than the free client/therapist-search flow below (which stays
  // exactly as-is for admin/staff, who may log a session for any therapist).
  const [scorecardClient, setScorecardClient] = useState(null);
  const [scorecardListQuery, setScorecardListQuery] = useState('');

  /** Synthesizes Section 1 + 2 + 3 inputs into a draft clinical summary the therapist can edit before submitting. */
  function generateGasSummary() {
    const scoredGoals = gasCurrentItems.filter(it => gasScores[it.id] !== undefined);
    const lines = [];
    if (gasParentObservation.trim()) lines.push(`Parent reported: ${gasParentObservation.trim()}`);
    for (const it of scoredGoals) {
      const lvl = gasScores[it.id];
      lines.push(`Goal "${it.title}": scored ${lvl > 0 ? '+' + lvl : lvl} (${it[GAS_LEVEL_FIELD[String(lvl)]]}).`);
    }
    if (gasPreviewScore != null) lines.push(`Overall GAS T-score for this session: ${gasPreviewScore}.`);
    if (gasForm.remarks.trim()) lines.push('Plans, Analysis, and Instructions: ' + gasForm.remarks.trim());
    setGasSummaryDraft(lines.join('\n'));
  }
  const [gasTherapistQuery, setGasTherapistQuery] = useState('');
  const [gasTherapistOpen, setGasTherapistOpen] = useState(false);
  // Names of therapists who actually have session history (real, non-cancelled reservations)
  // with the currently selected child, derived from real booking records, not a fabricated list.
  const [gasAssignedTherapists, setGasAssignedTherapists] = useState([]);
  const [gasAssignedLoading, setGasAssignedLoading] = useState(false);

  /** Distinct therapist names with real (non-cancelled/declined) reservation history for a child. */
  async function fetchAssignedTherapists(clientId) {
    if (!clientId) return [];
    const rows = await api('/reservations?client_id=' + clientId);
    return [...new Set(
      (rows || [])
        .filter(r => !['cancelled', 'declined'].includes(r.status) && r.therapist_name)
        .map(r => r.therapist_name)
    )].sort();
  }

  // Switching the selected child resets the therapist pick, a therapist assigned to
  // the previous child isn't necessarily valid for the new one. A locked ot/speech
  // account skips all of this, they ARE the therapist submitting the entry, so
  // there's nothing to search/select; therapist_name is just their own name.
  useEffect(() => {
    if (lockedDiscipline) { setGasForm(f => ({ ...f, therapist_name: user?.name || '' })); return; }
    setGasTherapistQuery('');
    if (!gasForm.client_id) { setGasForm(f => ({ ...f, therapist_name: '' })); setGasAssignedTherapists([]); return; }

    // The child already has a designated therapist from Client Records, use it
    // directly. There's nothing to pick when the assignment already exists.
    // A Combined client has two independent assignments (one OT, one Speech),
    // so which one applies depends on the discipline tab currently selected,
    // never a single shared field, otherwise an entry could get silently
    // attributed to the wrong discipline's therapist.
    const client = gasClients.find(c => c.id === gasForm.client_id);
    const assignedField = DISCIPLINE_THERAPY_CODE[gasDiscipline] === 'Speech' ? 'assigned_speech_therapist_name' : 'assigned_ot_therapist_name';
    if (client?.[assignedField]) {
      setGasForm(f => ({ ...f, therapist_name: client[assignedField] }));
      setGasAssignedTherapists([]);
      return;
    }

    // No Client Records assignment yet (brand-new child), fall back to
    // reservation history, or every registered therapist if there's none.
    setGasForm(f => ({ ...f, therapist_name: '' }));
    setGasAssignedLoading(true);
    fetchAssignedTherapists(gasForm.client_id)
      .then(setGasAssignedTherapists)
      .catch(() => setGasAssignedTherapists([]))
      .finally(() => setGasAssignedLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gasForm.client_id, lockedDiscipline, gasDiscipline]);

  // The child's actually-assigned therapists if they have session history; otherwise every
  // registered therapist, so a brand-new child's very first session can still be logged.
  const gasTherapistPool = gasAssignedTherapists.length
    ? gasTherapists.filter(t => gasAssignedTherapists.includes(t.name))
    : gasTherapists;

  const [gasManageOpen, setGasManageOpen] = useState(false);
  const [gasManageSetId, setGasManageSetId] = useState(null); // set being item-edited within the modal; null = set list
  const [gasNewSetName, setGasNewSetName] = useState('');
  const [gasRenamingId, setGasRenamingId] = useState(null);
  const [gasRenameValue, setGasRenameValue] = useState('');
  const [gasItemDraft, setGasItemDraft] = useState(emptyGasItemDraft());
  const [gasEditingItemId, setGasEditingItemId] = useState(null);

  async function loadGasData(discipline) {
    setGasLoading(true);
    try {
      const [sets, entries] = await Promise.all([
        api('/gas/questionnaires?discipline=' + encodeURIComponent(discipline)),
        api('/gas/entries?discipline=' + encodeURIComponent(discipline))
      ]);
      setGasSets(prev => ({ ...prev, [discipline]: sets }));
      setGasEntries(prev => ({ ...prev, [discipline]: entries }));
      setGasSetId(prev => {
        if (prev[discipline]) return prev;
        const active = sets.find(s => s.status === 'active') || sets[0];
        return { ...prev, [discipline]: active ? active.id : '' };
      });
    } catch (e) {
      toast(e.message || 'Failed to load GAS data', 'fa-triangle-exclamation');
    } finally {
      setGasLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== 'scorecard' && tab !== 'entries') return;
    if (!gasClients.length) api('/clients').then(setGasClients).catch(e => toast(e.message || 'Failed to load clients', 'fa-triangle-exclamation'));
    if (!gasTherapists.length) api('/shifts').then(setGasTherapists).catch(e => toast(e.message || 'Failed to load therapists', 'fa-triangle-exclamation'));
    // Preload every discipline this user can see (not just the currently selected
    // one) so the combined Session Entries tab has every entry available, a
    // locked ot/speech account only ever preloads its own single discipline.
    for (const d of visibleDisciplines) if (!gasSets[d]) loadGasData(d);
  }, [tab]);

  // A discipline-locked therapist can never be looking at the other discipline's
  // scorecard, even before this state's own default (GAS_DISCIPLINES[0]) happens to match.
  useEffect(() => {
    if (lockedDiscipline && gasDiscipline !== lockedDiscipline) setGasDisciplineTab(lockedDiscipline);
  }, [lockedDiscipline]);

  // Combined, chronological feed of every submitted GAS entry across every visible
  // discipline, powers the Session Entries tab. Stays within-discipline automatically
  // for a locked ot/speech account, since visibleDisciplines is just their one, and
  // further scoped to only their own caseload's entries, same rule as the Child dropdown.
  const gasAllEntries = visibleDisciplines.flatMap(d => gasEntries[d] || [])
    .filter(e => !lockedDiscipline || gasAssignedClientIds.has(e.client_id))
    .sort((a, b) => new Date(b.session_date) - new Date(a.session_date));

  const gasTherapistMatches = gasTherapistPool.filter(t => t.name.toLowerCase().includes(gasTherapistQuery.toLowerCase()));

  function selectGasTherapist(name) {
    setGasForm(f => ({ ...f, therapist_name: name }));
    setGasTherapistQuery(name);
    setGasTherapistOpen(false);
  }

  function blurGasTherapist() {
    // Give the option's onMouseDown a chance to fire before the list disappears,
    // then snap the visible text back to the last confirmed selection.
    setTimeout(() => {
      setGasTherapistOpen(false);
      setGasTherapistQuery(gasForm.therapist_name);
    }, 150);
  }

  const gasCurrentSets = gasSets[gasDiscipline] || [];
  const gasCurrentSetId = gasSetId[gasDiscipline] || '';
  const gasCurrentSet = gasCurrentSets.find(s => s.id === gasCurrentSetId) || null;
  const gasCurrentItems = gasCurrentSet?.items || [];
  const gasManageSet = gasCurrentSets.find(s => s.id === gasManageSetId) || null;

  // Admin/staff see every child whose therapy_type matches the discipline tab
  // currently open (an OT tool must never list a Speech-only child, and vice
  // versa), a child with no therapy_type yet (pending assessment) still shows
  // under either tab. A locked ot/speech account only ever sees their own real
  // caseload, children they actually have session history with.
  const gasFilteredClients = (lockedDiscipline
    ? gasClients.filter(c => gasAssignedClientIds.has(c.id))
    : gasClients.filter(c => !c.therapy_type || c.therapy_type === 'Both' || c.therapy_type === DISCIPLINE_THERAPY_CODE[gasDiscipline])
  ).slice().sort((a, b) => a.full_name.localeCompare(b.full_name));

  const gasSelectedClient = gasClients.find(c => c.id === gasForm.client_id) || null;

  const gasScoredCount = gasCurrentItems.filter(it => gasScores[it.id] !== undefined).length;
  const gasPreviewScore = gasScoredCount
    ? computeGasTScore(gasCurrentItems.filter(it => gasScores[it.id] !== undefined).map(it => ({ weight: Number(it.weight) || 1, level: gasScores[it.id] })))
    : null;

  const gasClientMatches = gasFilteredClients.filter(c => c.full_name.toLowerCase().includes(gasClientQuery.toLowerCase()));
  function blurGasClient() {
    setTimeout(() => {
      setGasClientOpen(false);
      setGasClientQuery(gasSelectedClient?.full_name || '');
    }, 150);
  }

  // Every goal defaults to level 0 (expected outcome) as soon as its questionnaire set
  // loads, so Step 2's sliders always start centered instead of unscored (a slider,
  // unlike a click-to-score button row, needs a starting position).
  useEffect(() => {
    if (!gasCurrentItems.length) return;
    setGasScores(prev => {
      let changed = false;
      const next = { ...prev };
      for (const it of gasCurrentItems) if (next[it.id] === undefined) { next[it.id] = 0; changed = true; }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gasCurrentItems]);

  function setGasDisciplineTab(d) {
    setGasDiscipline(d);
    setGasScores({});
    setGasManageSetId(null);
    setGasStep(1);
  }

  async function createGasSet() {
    const name = gasNewSetName.trim();
    if (!name) { toast('Enter a name for the new questionnaire set', 'fa-triangle-exclamation'); return; }
    try {
      const created = await api('/gas/questionnaires', { method: 'POST', body: { discipline: gasDiscipline, name } });
      setGasSets(prev => ({ ...prev, [gasDiscipline]: [created, ...(prev[gasDiscipline] || [])] }));
      setGasNewSetName('');
      toast('Questionnaire set "' + name + '" created as draft', 'fa-plus');
    } catch (e) { toast(e.message || 'Failed to create set', 'fa-triangle-exclamation'); }
  }

  function patchGasSetLocal(setId, patch) {
    setGasSets(prev => ({ ...prev, [gasDiscipline]: (prev[gasDiscipline] || []).map(s => s.id === setId ? { ...s, ...patch } : s) }));
  }

  async function setGasSetStatus(set, status) {
    try {
      const updated = await api('/gas/questionnaires/' + set.id, { method: 'PUT', body: { status } });
      patchGasSetLocal(set.id, updated);
      toast('"' + set.name + '" is now ' + status, 'fa-check');
    } catch (e) { toast(e.message || 'Failed to update set', 'fa-triangle-exclamation'); }
  }

  async function saveGasSetRename(set) {
    const name = gasRenameValue.trim();
    if (!name || name === set.name) { setGasRenamingId(null); return; }
    try {
      const updated = await api('/gas/questionnaires/' + set.id, { method: 'PUT', body: { name } });
      patchGasSetLocal(set.id, updated);
      toast('Questionnaire renamed', 'fa-pen');
    } catch (e) { toast(e.message || 'Failed to rename set', 'fa-triangle-exclamation'); }
    setGasRenamingId(null);
  }

  async function deleteGasSet(set) {
    try {
      await api('/gas/questionnaires/' + set.id, { method: 'DELETE' });
      setGasSets(prev => ({ ...prev, [gasDiscipline]: (prev[gasDiscipline] || []).filter(s => s.id !== set.id) }));
      if (gasManageSetId === set.id) setGasManageSetId(null);
      if (gasCurrentSetId === set.id) setGasSetId(prev => ({ ...prev, [gasDiscipline]: '' }));
      toast('Questionnaire deleted', 'fa-trash');
    } catch (e) { toast(e.message || 'Failed to delete set', 'fa-triangle-exclamation'); }
  }

  function startEditGasItem(item) {
    setGasEditingItemId(item.id);
    setGasItemDraft({
      title: item.title, description: item.description || '',
      level_m2: item.level_m2, level_m1: item.level_m1, level_0: item.level_0, level_p1: item.level_p1, level_p2: item.level_p2,
      weight: item.weight
    });
  }

  function cancelEditGasItem() {
    setGasEditingItemId(null);
    setGasItemDraft(emptyGasItemDraft());
  }

  async function saveGasItem(setId) {
    const d = gasItemDraft;
    if (!d.title || !d.level_m2 || !d.level_m1 || !d.level_0 || !d.level_p1 || !d.level_p2) {
      toast('Fill in the goal title and all 5 outcome levels', 'fa-triangle-exclamation');
      return;
    }
    try {
      if (gasEditingItemId) {
        const item = await api('/gas/items/' + gasEditingItemId, { method: 'PUT', body: d });
        patchGasSetLocal(setId, { items: (gasManageSet?.items || []).map(it => it.id === item.id ? item : it) });
      } else {
        const item = await api('/gas/questionnaires/' + setId + '/items', { method: 'POST', body: d });
        patchGasSetLocal(setId, { items: [...(gasManageSet?.items || []), item] });
      }
      cancelEditGasItem();
      toast('Goal saved', 'fa-check');
    } catch (e) { toast(e.message || 'Failed to save goal', 'fa-triangle-exclamation'); }
  }

  async function deleteGasItem(setId, itemId) {
    try {
      await api('/gas/items/' + itemId, { method: 'DELETE' });
      patchGasSetLocal(setId, { items: (gasManageSet?.items || []).filter(it => it.id !== itemId) });
      toast('Goal removed', 'fa-trash');
    } catch (e) { toast(e.message || 'Failed to delete goal', 'fa-triangle-exclamation'); }
  }

  async function submitGasEntry() {
    if (!gasForm.client_id) { toast('Select a child', 'fa-triangle-exclamation'); return; }
    if (!gasForm.session_date) { toast('Select a session date', 'fa-triangle-exclamation'); return; }
    if (gasForm.session_date > todayStr()) { toast('Session date cannot be in the future', 'fa-triangle-exclamation'); return; }
    if (!gasCurrentSet) { toast('Select a questionnaire set', 'fa-triangle-exclamation'); return; }
    if (gasScoredCount !== gasCurrentItems.length) { toast('Score every goal before submitting', 'fa-triangle-exclamation'); return; }

    // Parent observation (Section 1) has no dedicated column on gas_entries,
    // fold it into the remarks text alongside the edited summary draft (Section 3)
    // so nothing captured across the 3 stages gets lost on submit.
    const remarksParts = [];
    if (gasParentObservation.trim()) remarksParts.push(`Parent observation: ${gasParentObservation.trim()}`);
    if (gasSummaryDraft.trim()) remarksParts.push(gasSummaryDraft.trim());
    else if (gasForm.remarks.trim()) remarksParts.push(gasForm.remarks.trim());
    const combinedRemarks = remarksParts.join('\n\n');

    setGasSubmitting(true);
    try {
      const entry = await api('/gas/entries', {
        method: 'POST',
        body: {
          client_id: gasForm.client_id, questionnaire_id: gasCurrentSet.id,
          session_date: gasForm.session_date, therapist_name: gasForm.therapist_name, remarks: combinedRemarks,
          scores: gasCurrentItems.map(it => ({ item_id: it.id, level: gasScores[it.id] }))
        }
      });
      const client = gasClients.find(c => c.id === gasForm.client_id);
      setGasEntries(prev => ({ ...prev, [gasDiscipline]: [{ ...entry, client }, ...(prev[gasDiscipline] || [])] }));
      setGasScores({});
      setGasForm(f => ({ ...f, remarks: '' }));
      setGasParentObservation('');
      setGasSummaryDraft('');
      setGasStep(1);
      toast('GAS entry submitted, T-score ' + entry.gas_t_score, 'fa-clipboard-check');
    } catch (e) {
      toast(e.message || 'Failed to submit GAS entry', 'fa-triangle-exclamation');
    } finally {
      setGasSubmitting(false);
    }
  }

  /* ── Session Entries: view / edit a submitted GAS entry ── */
  const [gasEntriesFilter, setGasEntriesFilter] = useState('all'); // 'all' | discipline
  const [gasEntryIdSearch, setGasEntryIdSearch] = useState('');
  const [gasEntryDateFrom, setGasEntryDateFrom] = useState('');
  const [gasEntryDateTo, setGasEntryDateTo] = useState('');
  const [gasEntryPage, setGasEntryPage] = useState(1);
  const GAS_ENTRIES_PER_PAGE = 10;
  const [gasEntryModal, setGasEntryModal] = useState(null); // { mode: 'view'|'edit', entry }
  const [gasEditForm, setGasEditForm] = useState({ session_date: '', therapist_name: '', parentObservation: '', remarks: '' });
  const [gasEditScores, setGasEditScores] = useState({}); // { [item_id]: level }
  const [gasEditSaving, setGasEditSaving] = useState(false);
  const [gasArchiving, setGasArchiving] = useState(null); // entry id being archived
  // Same "assigned = real reservation history" scoping as the scorecard form, for the entry's own child.
  const [gasEditAssignedTherapists, setGasEditAssignedTherapists] = useState([]);
  const [gasEntrySelected, setGasEntrySelected] = useState(new Set()); // bulk-select, mirrors Users.jsx
  const [gasBulkArchiving, setGasBulkArchiving] = useState(false);
  // Confirm-before-archive, a real modal instead of the native browser confirm()
  // dialog: null | { type: 'bulk', count } | { type: 'single', entry }
  const [gasArchiveConfirm, setGasArchiveConfirm] = useState(null);

  const gasDisciplineEntries = (gasEntriesFilter === 'all' ? gasAllEntries : gasAllEntries.filter(e => e.discipline === gasEntriesFilter))
    .filter(e => !gasEntryDateFrom || e.session_date >= gasEntryDateFrom)
    .filter(e => !gasEntryDateTo || e.session_date <= gasEntryDateTo);
  const gasVisibleEntries = gasEntryIdSearch.trim()
    ? gasDisciplineEntries.filter(e => {
        const q = gasEntryIdSearch.trim().toLowerCase();
        return String(e.id).toLowerCase().includes(q)
          || String(e.client?.client_code || '').toLowerCase().includes(q)
          || String(e.client?.full_name || '').toLowerCase().includes(q);
      })
    : gasDisciplineEntries;
  const gasEntryPageCount = Math.max(1, Math.ceil(gasVisibleEntries.length / GAS_ENTRIES_PER_PAGE));
  const gasEntryPageSafe = Math.min(gasEntryPage, gasEntryPageCount);
  const gasPagedEntries = gasVisibleEntries.slice((gasEntryPageSafe - 1) * GAS_ENTRIES_PER_PAGE, gasEntryPageSafe * GAS_ENTRIES_PER_PAGE);
  const gasEditTherapistPool = gasEditAssignedTherapists.length
    ? gasTherapists.filter(t => gasEditAssignedTherapists.includes(t.name))
    : gasTherapists;
  const gasAllVisibleSelected = gasPagedEntries.length > 0 && gasPagedEntries.every(e => gasEntrySelected.has(e.id));

  function toggleGasEntrySelect(id) {
    setGasEntrySelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleGasEntrySelectAll() {
    setGasEntrySelected(gasAllVisibleSelected ? new Set() : new Set(gasPagedEntries.map(e => e.id)));
  }

  function bulkArchiveGasEntries() {
    if (!gasEntrySelected.size) return;
    setGasArchiveConfirm({ type: 'bulk', count: gasEntrySelected.size });
  }

  async function doBulkArchiveGasEntries() {
    const ids = [...gasEntrySelected];
    setGasArchiveConfirm(null);
    if (!ids.length) return;
    setGasBulkArchiving(true);
    try {
      await Promise.all(ids.map(id => api('/gas/entries/' + id, { method: 'DELETE' })));
      setGasEntries(prev => {
        const next = {};
        for (const d of GAS_DISCIPLINES) next[d] = (prev[d] || []).filter(e => !gasEntrySelected.has(e.id));
        return next;
      });
      toast(ids.length + ' GAS entr' + (ids.length === 1 ? 'y' : 'ies') + ' archived', 'fa-box-archive');
      setGasEntrySelected(new Set());
    } catch (e) {
      toast(e.message || 'Failed to archive entries', 'fa-triangle-exclamation');
    } finally {
      setGasBulkArchiving(false);
    }
  }

  function openGasView(entry) {
    setGasEntryModal({ mode: 'view', entry });
  }

  function openGasEdit(entry) {
    setGasEntryModal({ mode: 'edit', entry });
    const { parentObservation, remarks } = splitGasRemarks(entry.remarks);
    setGasEditForm({ session_date: entry.session_date, therapist_name: entry.therapist_name || '', parentObservation, remarks });
    const scores = {};
    for (const s of entry.scores || []) if (s.item_id) scores[s.item_id] = s.level;
    setGasEditScores(scores);
    setGasEditAssignedTherapists([]);
    if (entry.client_id) {
      fetchAssignedTherapists(entry.client_id).then(setGasEditAssignedTherapists).catch(() => setGasEditAssignedTherapists([]));
    }
  }

  function closeGasEntryModal() {
    setGasEntryModal(null);
  }

  function archiveGasEntry(entry) {
    setGasArchiveConfirm({ type: 'single', entry });
  }

  async function doArchiveGasEntry(entry) {
    setGasArchiveConfirm(null);
    setGasArchiving(entry.id);
    try {
      await api('/gas/entries/' + entry.id, { method: 'DELETE' });
      setGasEntries(prev => ({
        ...prev,
        [entry.discipline]: (prev[entry.discipline] || []).filter(e => e.id !== entry.id)
      }));
      setGasEntrySelected(prev => { const next = new Set(prev); next.delete(entry.id); return next; });
      toast('GAS entry archived', 'fa-box-archive');
    } catch (e) {
      toast(e.message || 'Failed to archive entry', 'fa-triangle-exclamation');
    } finally {
      setGasArchiving(null);
    }
  }

  // Full 5-level goal definitions for the entry being edited, so re-scoring shows the same
  // descriptive text as the original scoring form (falls back gracefully if the questionnaire
  // or goal was since edited/archived/deleted, the entry's own snapshot still has the level text).
  const gasEditQuestionnaireItems = gasEntryModal?.entry
    ? (gasSets[gasEntryModal.entry.discipline] || []).find(s => s.id === gasEntryModal.entry.questionnaire_id)?.items || []
    : [];

  function generateGasEditSummary() {
    const entry = gasEntryModal.entry;
    const lines = [];
    if (gasEditForm.parentObservation.trim()) lines.push(`Parent reported: ${gasEditForm.parentObservation.trim()}`);
    for (const s of entry.scores || []) {
      const liveItem = s.item_id ? gasEditQuestionnaireItems.find(it => it.id === s.item_id) : null;
      const level = s.item_id ? gasEditScores[s.item_id] : s.level;
      const levelLabel = liveItem ? liveItem[GAS_LEVEL_FIELD[String(level)]] : s.level_label;
      lines.push(`Goal "${s.item_title}": scored ${level > 0 ? '+' + level : level} (${levelLabel}).`);
    }
    const scored = (entry.scores || [])
      .filter(s => s.item_id && gasEditScores[s.item_id] !== undefined)
      .map(s => ({ weight: Number(s.weight) || 1, level: gasEditScores[s.item_id] }));
    const tScore = scored.length ? computeGasTScore(scored) : null;
    if (tScore != null) lines.push(`Overall GAS T-score for this session: ${tScore}.`);
    setGasEditForm(f => ({ ...f, remarks: lines.join('\n') }));
  }

  async function saveGasEdit() {
    if (!gasEditForm.session_date) { toast('Select a session date', 'fa-triangle-exclamation'); return; }
    if (gasEditForm.session_date > todayStr()) { toast('Session date cannot be in the future', 'fa-triangle-exclamation'); return; }

    const entry = gasEntryModal.entry;
    const scores = (entry.scores || [])
      .filter(s => s.item_id && gasEditScores[s.item_id] !== undefined)
      .map(s => ({ item_id: s.item_id, level: gasEditScores[s.item_id] }));

    const remarksParts = [];
    if (gasEditForm.parentObservation.trim()) remarksParts.push(`Parent observation: ${gasEditForm.parentObservation.trim()}`);
    if (gasEditForm.remarks.trim()) remarksParts.push(gasEditForm.remarks.trim());
    const combinedRemarks = remarksParts.join('\n\n');

    setGasEditSaving(true);
    try {
      const updated = await api('/gas/entries/' + entry.id, {
        method: 'PUT',
        body: { session_date: gasEditForm.session_date, therapist_name: gasEditForm.therapist_name, remarks: combinedRemarks, scores }
      });
      setGasEntries(prev => ({
        ...prev,
        [entry.discipline]: (prev[entry.discipline] || []).map(e => e.id === entry.id ? { ...e, ...updated, client: e.client } : e)
      }));
      toast('GAS entry updated, T-score ' + updated.gas_t_score, 'fa-check');
      closeGasEntryModal();
    } catch (e) {
      toast(e.message || 'Failed to update GAS entry', 'fa-triangle-exclamation');
    } finally {
      setGasEditSaving(false);
    }
  }

  return (
    <div className="spa-page" id="spa-milestones">
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Milestone Scorecard</h1>
        </div>
        {!lockedDiscipline && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={() => openMsModal('new-entry')}><i className="fa-solid fa-plus" style={{ color: '#0EA5E9' }} /> Log New Session</button>
            <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={() => toast('Scoreboard exported', 'fa-download')}><i className="fa-solid fa-download" style={{ color: '#0D9488' }} /> Export</button>
          </div>
        )}
      </div>


      {/* View tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className={'tab-pill' + (tab === 'scorecard' ? ' active' : '')} onClick={() => setTab('scorecard')}><i className="fa-solid fa-file-pen" style={{ marginRight: 6 }} />GAS Scorecard Input</button>
        <button className={'tab-pill' + (tab === 'entries' ? ' active' : '')} onClick={() => setTab('entries')}><i className="fa-solid fa-table-list" style={{ marginRight: 6 }} />Session Entries</button>
      </div>

      {/* ═══════ TAB: SCORECARD INPUT (5.1 / 5.2 / 5.2.1 / 5.2.2 / 5.3 / 5.4) ═══════ */}
      <div id="tab-scorecard" style={{ display: tab === 'scorecard' ? '' : 'none' }}>

        {/* ─── GAS (Goal Attainment Scaling) assessment questionnaire tool ─── */}
        <div className="card" style={{ padding: '22px 20px', marginBottom: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 4 }}>
            <div>
              <div className="section-title"><i className="fa-solid fa-bullseye" style={{ color: '#4F46E5', marginRight: 7 }} />GAS Assessment Questionnaire</div>
            </div>
            {isGasAdmin && (
              <button className="qa-btn" style={{ width: 'auto', padding: '9px 14px', fontSize: 12.5 }} onClick={() => { setGasManageOpen(true); setGasManageSetId(null); }}>
                <i className="fa-solid fa-sliders" style={{ color: '#4F46E5' }} /> Manage Questionnaire Sets
              </button>
            )}
          </div>

          {/* Discipline sub-tabs, narrowed to one for a discipline-locked therapist */}
          <div style={{ display: 'flex', gap: 6, margin: '16px 0' }}>
            {visibleDisciplines.map(d => (
              <button key={d} className={'tab-pill' + (gasDiscipline === d ? ' active' : '')} onClick={() => setGasDisciplineTab(d)}>
                <i className={'fa-solid ' + (d === 'Speech-Language Therapy' ? 'fa-comments' : 'fa-hands') } style={{ marginRight: 6 }} />{d}
              </button>
            ))}
          </div>

          {gasLoading && !gasCurrentSets.length ? (
            <div style={{ padding: '30px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading questionnaire data…</div>
          ) : (
            <>
              {/* ── Discipline-locked therapist: client picker, like Client Records, clicking a child opens the wizard modal ── */}
              {lockedDiscipline && (
                <div>
                  <div style={{ position: 'relative', marginBottom: 14 }}>
                    <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8', fontSize: 12 }} />
                    <input
                      className="form-input" style={{ paddingLeft: 32, maxWidth: 340 }}
                      placeholder="Search your clients…" autoComplete="off"
                      value={scorecardListQuery} onChange={e => setScorecardListQuery(e.target.value)}
                    />
                  </div>
                  {gasAssignedClientsLoading ? (
                    <div style={{ padding: '24px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading your clients…</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {gasFilteredClients.filter(c => c.full_name.toLowerCase().includes(scorecardListQuery.toLowerCase())).map(c => (
                        <div
                          key={c.id} onClick={() => setScorecardClient(c)}
                          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, border: '1px solid #E2E8F0', cursor: 'pointer', transition: 'background .15s' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#F8FAFC'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          {c.photo_url ? (
                            <img src={c.photo_url} alt={c.full_name} style={{ width: 36, height: 36, borderRadius: 9, objectFit: 'cover', flexShrink: 0 }} />
                          ) : (
                            <div style={{ width: 36, height: 36, borderRadius: 9, background: 'linear-gradient(135deg,#0EA5E9,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                              {(c.full_name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>{c.full_name}</div>
                            <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{c.client_code}</div>
                          </div>
                          <i className="fa-solid fa-chevron-right" style={{ color: '#94A3B8', fontSize: 12 }} />
                        </div>
                      ))}
                      {!gasFilteredClients.length && (
                        <div style={{ padding: '24px 0', textAlign: 'center', color: '#94A3B8', fontSize: 12.5 }}>No children with session history assigned to you yet.</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {!lockedDiscipline && !gasCurrentSets.length && (
                <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '10px 0 18px' }}>
                  No questionnaire sets yet for {gasDiscipline}.{isGasAdmin ? ' Use "Manage Questionnaire Sets" to create one.' : ''}
                </div>
              )}

              {!lockedDiscipline && gasCurrentSets.length > 0 && (
                <>
                  {/* Step stepper */}
                  <div className="gas-stepper">
                    {GAS_STEPS.map((s, i) => (
                      <span key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          className={'gas-step-pill' + (gasStep === s.n ? ' current' : gasStep > s.n ? ' done' : '')}
                          onClick={() => gasGoToStep(s.n)}
                        >
                          <span className="num">{gasStep > s.n ? <i className="fa-solid fa-check" /> : s.n}</span>
                          Step {s.n}: {s.label}
                        </span>
                        {i < GAS_STEPS.length - 1 && <i className="fa-solid fa-angle-right gas-step-arrow" />}
                      </span>
                    ))}
                  </div>

                  {/* ── Step 1: Before Session ── */}
                  {gasStep === 1 && (
                    <div className="gas-two-col">
                      {/* Left: inputs */}
                      <div>
                        <div style={{ position: 'relative', marginBottom: 14 }}>
                          <label className="form-label">Client Selection{lockedDiscipline ? ', your caseload' : ''} *</label>
                          <div style={{ position: 'relative' }}>
                            <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94A3B8', fontSize: 12 }} />
                            <input
                              className="form-input" style={{ paddingLeft: 32 }}
                              placeholder={lockedDiscipline && gasAssignedClientsLoading ? 'Loading your caseload…' : 'Search Therapist\'s Clients…'}
                              autoComplete="off"
                              disabled={lockedDiscipline && gasAssignedClientsLoading}
                              value={gasClientQuery || gasSelectedClient?.full_name || ''}
                              onChange={e => { setGasClientQuery(e.target.value); setGasForm(f => ({ ...f, client_id: '' })); setGasClientOpen(true); }}
                              onFocus={() => setGasClientOpen(true)}
                              onBlur={blurGasClient}
                            />
                          </div>
                          {gasClientOpen && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, maxHeight: 190, overflowY: 'auto', background: '#fff', border: '1px solid #E2E8F0', borderRadius: 9, boxShadow: '0 8px 20px rgba(15,23,42,.12)' }}>
                              {gasClientMatches.map(c => (
                                <div key={c.id} onMouseDown={() => selectGasClientOption(c)}
                                  style={{ padding: '8px 12px', fontSize: 12.5, color: '#334155', cursor: 'pointer' }}
                                  onMouseEnter={e => e.currentTarget.style.background = '#F1F5F9'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                  {c.full_name} <span style={{ color: '#94A3B8' }}>· {c.client_code}</span>
                                </div>
                              ))}
                              {!gasClientMatches.length && (
                                <div style={{ padding: '8px 12px', fontSize: 12, color: '#94A3B8' }}>No clients match "{gasClientQuery}"</div>
                              )}
                            </div>
                          )}
                          {lockedDiscipline && !gasAssignedClientsLoading && !gasFilteredClients.length && (
                            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>No children with session history assigned to you yet.</div>
                          )}
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
                          <div><label className="form-label">Session Date *</label><input className="form-input" type="date" max={todayStr()} value={gasForm.session_date} onChange={e => setGasForm(f => ({ ...f, session_date: e.target.value }))} /></div>
                          {!lockedDiscipline ? (
                            <div style={{ position: 'relative' }}>
                              <label className="form-label">Therapist</label>
                              {gasSelectedClient?.[DISCIPLINE_THERAPY_CODE[gasDiscipline] === 'Speech' ? 'assigned_speech_therapist_name' : 'assigned_ot_therapist_name'] ? (
                                <input className="form-input" value={gasSelectedClient[DISCIPLINE_THERAPY_CODE[gasDiscipline] === 'Speech' ? 'assigned_speech_therapist_name' : 'assigned_ot_therapist_name']} disabled />
                              ) : (
                                <>
                                  <input
                                    className="form-input"
                                    placeholder={!gasForm.client_id ? 'Select a child first…' : gasAssignedLoading ? 'Loading…' : 'Search therapists…'}
                                    autoComplete="off"
                                    disabled={!gasForm.client_id || gasAssignedLoading}
                                    value={gasTherapistQuery}
                                    onChange={e => { setGasTherapistQuery(e.target.value); setGasForm(f => ({ ...f, therapist_name: '' })); setGasTherapistOpen(true); }}
                                    onFocus={() => setGasTherapistOpen(true)}
                                    onBlur={blurGasTherapist}
                                  />
                                  {gasTherapistOpen && (
                                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, maxHeight: 190, overflowY: 'auto', background: '#fff', border: '1px solid #E2E8F0', borderRadius: 9, boxShadow: '0 8px 20px rgba(15,23,42,.12)' }}>
                                      {gasTherapistMatches.map(t => (
                                        <div key={t.therapist_id} onMouseDown={() => selectGasTherapist(t.name)}
                                          style={{ padding: '8px 12px', fontSize: 12.5, color: '#334155', cursor: 'pointer' }}
                                          onMouseEnter={e => e.currentTarget.style.background = '#F1F5F9'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                          {t.name}
                                        </div>
                                      ))}
                                      {!gasTherapistMatches.length && (
                                        <div style={{ padding: '8px 12px', fontSize: 12, color: '#94A3B8' }}>No therapists match "{gasTherapistQuery}"</div>
                                      )}
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          ) : (
                            <div><label className="form-label">Therapist</label><input className="form-input" value={user?.name || ''} disabled /></div>
                          )}
                        </div>

                        <div>
                          <label className="form-label">Parent Observation</label>
                          <textarea className="form-input" rows="4" style={{ height: 'auto', padding: '10px 12px', resize: 'vertical' }}
                            placeholder="Parent observation text notes…" value={gasParentObservation} onChange={e => setGasParentObservation(e.target.value)} />
                        </div>
                      </div>

                      {/* Right: Client Records (read-only historical context) */}
                      <div>
                        <label className="form-label">Client Records</label>
                        {!gasForm.client_id ? (
                          <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '30px 0', textAlign: 'center' }}>Select a client to view their records.</div>
                        ) : gasClientRecordLoading ? (
                          <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '30px 0', textAlign: 'center' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading records…</div>
                        ) : (
                          <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 2 }}>
                            {[
                              { key: 'notes', label: 'Recent Session Notes', body: (gasClientRecord?.session_notes || []).slice(-5).reverse().map(n => `${n.session_date} · ${n.domain}: ${n.score}${n.remark ? ' — ' + n.remark : ''}`).join('\n') || 'No session notes yet.' },
                              { key: 'allergies', label: 'Allergies', body: gasClientRecord?.allergies || 'None recorded.' },
                              { key: 'meds', label: 'Medical Alerts / Medication', body: gasClientRecord?.daily_medication || 'None recorded.' },
                              { key: 'gas', label: 'Recent GAS Summary', body: (gasClientRecord?.gas_entries || []).filter(e => e.discipline === gasDiscipline).slice(-5).reverse().map(e => `${e.session_date} · T-score ${e.gas_t_score}`).join('\n') || 'No GAS entries yet for this discipline.' }
                            ].map(row => (
                              <div key={row.key} className="gas-record-row" onClick={() => setGasRecordExpanded(x => x === row.key ? null : row.key)} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span>{row.label}</span>
                                  <i className={'fa-solid ' + (gasRecordExpanded === row.key ? 'fa-chevron-up' : 'fa-chevron-down')} style={{ fontSize: 10, color: '#94A3B8' }} />
                                </div>
                                {gasRecordExpanded === row.key && <div className="body">{row.body}</div>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Navigation */}
                      <div style={{ gridColumn: '1/-1', display: 'flex', justifyContent: 'flex-end' }}>
                        <button className="btn-primary" onClick={gasNextStep}>Next <i className="fa-solid fa-angle-right" style={{ marginLeft: 6 }} /></button>
                      </div>
                    </div>
                  )}

                  {/* ── Step 2: During Session ── */}
                  {gasStep === 2 && (
                    <div>
                      {/* GAS Assessment Questionnaire Set */}
                      <div style={{ marginBottom: 18 }}>
                        <div style={{ marginBottom: 14 }}>
                          <label className="form-label">GAS Assessment Questionnaire Set</label>
                          <select className="form-select" value={gasCurrentSetId} onChange={e => { setGasSetId(prev => ({ ...prev, [gasDiscipline]: e.target.value })); setGasScores({}); }}>
                            <option value="">- Select a questionnaire set -</option>
                            {gasCurrentSets.map(s => (
                              <option key={s.id} value={s.id}>{s.name}, {s.status} ({(s.items || []).length} goals)</option>
                            ))}
                          </select>
                        </div>

                        {gasCurrentSet ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 560, overflowY: 'auto', paddingRight: 4 }}>
                            {gasCurrentItems.map(it => {
                              const lvl = gasScores[it.id] ?? 0;
                              return (
                                <div key={it.id} style={{ padding: 12, borderRadius: 10, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Goal: {it.title}</div>
                                    <span style={{ fontSize: 10.5, color: '#94A3B8', whiteSpace: 'nowrap' }}>weight ×{it.weight}</span>
                                  </div>
                                  {it.description && <div style={{ fontSize: 11.5, color: '#64748B', marginBottom: 4 }}>{it.description}</div>}
                                  <input
                                    type="range" min={-2} max={2} step={1} value={lvl}
                                    className="gas-goal-slider"
                                    onChange={e => setGasScores(prev => ({ ...prev, [it.id]: Number(e.target.value) }))}
                                  />
                                  <div className="gas-slider-scale">
                                    <span>[-2]</span><span>-1</span><span>0</span><span>+1</span><span>[+2]</span>
                                  </div>
                                  <div style={{ marginTop: 8, fontSize: 11.5, color: '#334155', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 7, padding: '6px 9px' }}>
                                    {it[GAS_LEVEL_FIELD[String(lvl)]]}
                                  </div>
                                </div>
                              );
                            })}
                            {!gasCurrentItems.length && (
                              <div style={{ fontSize: 12.5, color: '#94A3B8' }}>This questionnaire set has no goals yet.{isGasAdmin ? ' Add goals via "Manage Questionnaire Sets".' : ''}</div>
                            )}
                          </div>
                        ) : (
                          <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '20px 0' }}>Select a questionnaire set to begin scoring goals.</div>
                        )}
                      </div>

                      {/* GAS Score Trend, below the questionnaire */}
                      <div style={{ marginBottom: 18 }}>
                        <label className="form-label">GAS Score Trend (Inputted on Scale)</label>
                        <div style={{ padding: 12, borderRadius: 10, background: '#F5F3FF', border: '1px solid #DDD6FE', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12.5, color: '#4F46E5', fontWeight: 600 }}>Live GAS T-Score Preview</span>
                          <span style={{ fontSize: 20, fontWeight: 700, color: '#4F46E5' }}>{gasPreviewScore ?? '-'}</span>
                        </div>
                      </div>

                      {/* Navigation */}
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <button className="btn-secondary" onClick={gasPrevStep}><i className="fa-solid fa-angle-left" style={{ marginRight: 6 }} />Back</button>
                        <button className="btn-primary" onClick={gasNextStep}>Next <i className="fa-solid fa-angle-right" style={{ marginLeft: 6 }} /></button>
                      </div>
                    </div>
                  )}

                  {/* ── Step 3: After Assessment ── */}
                  {gasStep === 3 && (
                    <div className="gas-two-col">
                      {/* Left: Documentation & Actions */}
                      <div>
                        <label className="form-label">Remarks: Plans, Analysis, and Instructions</label>
                        <textarea className="form-input" rows="10" style={{ height: 'auto', padding: '10px 12px', resize: 'vertical', marginBottom: 12 }}
                          placeholder="Remarks: Plans, Analysis, and Instructions" value={gasForm.remarks} onChange={e => setGasForm(f => ({ ...f, remarks: e.target.value }))} />
                        <button className="btn-secondary" style={{ width: '100%' }} onClick={generateGasSummary}>
                          <i className="fa-solid fa-file-lines" style={{ marginRight: 6 }} />Generate Summary
                        </button>
                      </div>

                      {/* Right: Summary Preview & Submit */}
                      <div>
                        <label className="form-label">Summary Preview</label>
                        <textarea className="form-input" rows="10" style={{ height: 'auto', padding: '10px 12px', resize: 'vertical', marginBottom: 12 }}
                          placeholder="Click “Generate Summary” to draft a note from Sections 1–3, then edit as needed…"
                          value={gasSummaryDraft} onChange={e => setGasSummaryDraft(e.target.value)} />
                        <button className="btn-primary" style={{ width: '100%' }} disabled={gasSubmitting} onClick={submitGasEntry}>
                          <i className="fa-solid fa-paper-plane" style={{ marginRight: 6 }} />{gasSubmitting ? 'Submitting…' : 'Submit Session'}
                        </button>
                        <div style={{ marginTop: 10, fontSize: 12, color: '#64748B', textAlign: 'right' }}>{gasScoredCount} / {gasCurrentItems.length} goals scored</div>
                      </div>

                      {/* Navigation */}
                      <div style={{ gridColumn: '1/-1' }}>
                        <button className="btn-secondary" onClick={gasPrevStep}><i className="fa-solid fa-angle-left" style={{ marginRight: 6 }} />Back</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

      </div>

      {/* ═══════ TAB: SESSION ENTRIES ═══════ */}
      <div id="tab-entries" style={{ display: tab === 'entries' ? '' : 'none' }}>
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div><div className="section-title">All Session Entries</div></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div className="dir-search"><i className="fa-solid fa-magnifying-glass" /><input type="text" className="filter-input" placeholder="Search client name, code, or entry ID…" style={{ paddingLeft: 30, height: 34, fontSize: 12.5, width: 210 }} value={gasEntryIdSearch} onChange={e => { setGasEntryIdSearch(e.target.value); setGasEntryPage(1); setGasEntrySelected(new Set()); }} /></div>
              <input type="date" className="form-input" title="From date" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={gasEntryDateFrom} max={gasEntryDateTo || undefined} onChange={e => { setGasEntryDateFrom(e.target.value); setGasEntryPage(1); setGasEntrySelected(new Set()); }} />
              <input type="date" className="form-input" title="To date" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={gasEntryDateTo} min={gasEntryDateFrom || undefined} onChange={e => { setGasEntryDateTo(e.target.value); setGasEntryPage(1); setGasEntrySelected(new Set()); }} />
              {(gasEntryDateFrom || gasEntryDateTo) && (
                <button className="btn-secondary" style={{ height: 34, fontSize: 12.5 }} onClick={() => { setGasEntryDateFrom(''); setGasEntryDateTo(''); setGasEntryPage(1); }}>Clear dates</button>
              )}
              {visibleDisciplines.length > 1 && (
                <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={gasEntriesFilter} onChange={e => { setGasEntriesFilter(e.target.value); setGasEntryPage(1); setGasEntrySelected(new Set()); }}>
                  <option value="all">All Disciplines</option>
                  {GAS_DISCIPLINES.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
            </div>
          </div>
          {/* Bulk actions apply to 2+ entries, a single entry has its own row buttons. */}
          {gasEntrySelected.size > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', background: '#F0F9FF', borderBottom: '1px solid #BAE6FD', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#0284C7' }}><i className="fa-solid fa-check-square" style={{ marginRight: 6 }} />{gasEntrySelected.size} selected</span>
              <button className="btn-danger" disabled={gasBulkArchiving} onClick={bulkArchiveGasEntries}><i className="fa-solid fa-box-archive" style={{ marginRight: 4 }} />{gasBulkArchiving ? 'Archiving…' : 'Archive'}</button>
              <span style={{ fontSize: 12, color: '#64748B', cursor: 'pointer', marginLeft: 'auto', fontWeight: 500 }} onClick={() => setGasEntrySelected(new Set())}>Clear selection</span>
            </div>
          )}
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 24 }}><input type="checkbox" style={{ accentColor: '#0EA5E9', width: 14, height: 14, cursor: 'pointer' }} checked={gasAllVisibleSelected} onChange={toggleGasEntrySelectAll} title="Select all" /></th>
                  <th>Client</th>
                  <th>Discipline</th>
                  <th>Date</th>
                  <th>Therapist</th>
                  <th>T-Score</th>
                  <th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {gasPagedEntries.map(e => (
                  <tr key={e.id}>
                    <td style={{ paddingLeft: 24 }}><input type="checkbox" style={{ accentColor: '#0EA5E9', width: 14, height: 14, cursor: 'pointer' }} checked={gasEntrySelected.has(e.id)} onChange={() => toggleGasEntrySelect(e.id)} /></td>
                    <td>
                      <div style={{ fontWeight: 600, color: '#0F172A' }}>{e.client?.full_name || 'Unknown child'}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8' }}>{e.client?.client_code}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{e.discipline}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {e.session_date}
                      {e.is_late && <span className="pill pill-red" style={{ marginLeft: 6, fontSize: 10.5 }} title="Logged more than a day after the session">Late</span>}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{e.therapist_name || '-'}</td>
                    <td><span className={'pill pill-' + gasScoreTone(e.gas_t_score)}>{e.gas_t_score}</span></td>
                    <td style={{ textAlign: 'right', paddingRight: 24 }}>
                      <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                        <button className="btn-edit" onClick={() => openGasEdit(e)}>Edit</button>
                        <button className="btn-edit" onClick={() => openGasView(e)}>View</button>
                        <button className="btn-danger" disabled={gasArchiving === e.id} onClick={() => archiveGasEntry(e)}>{gasArchiving === e.id ? 'Archiving…' : 'Archive'}</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!gasPagedEntries.length && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: '#94A3B8', fontSize: 12.5, padding: '24px 0' }}>{gasEntryIdSearch.trim() || gasEntryDateFrom || gasEntryDateTo ? 'No GAS entries match those filters.' : lockedDiscipline ? 'No GAS entries submitted yet for your caseload.' : 'No GAS entries submitted yet.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="dir-foot">
            <span style={{ fontSize: 12, color: '#64748B' }}>Showing {gasPagedEntries.length} of {gasVisibleEntries.length} entries</span>
            <div className="pagination">
              <button className="page-btn" disabled={gasEntryPageSafe <= 1} onClick={() => setGasEntryPage(p => Math.max(1, p - 1))}>← Prev</button>
              {Array.from({ length: gasEntryPageCount }, (_, i) => i + 1).map(p => (
                <button key={p} className={'page-btn' + (p === gasEntryPageSafe ? ' active' : '')} onClick={() => setGasEntryPage(p)}>{p}</button>
              ))}
              <button className="page-btn" disabled={gasEntryPageSafe >= gasEntryPageCount} onClick={() => setGasEntryPage(p => Math.min(gasEntryPageCount, p + 1))}>Next →</button>
            </div>
          </div>
        </div>
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Milestone Scorecard</span></div>

      {/* ═══════ Page-local modals ═══════ */}
      {msModal && msModal.type === 'new-entry' && (
        <NewSessionEntryModal onClose={closeModal} toast={toast} />
      )}

      {scorecardClient && (
        <ScorecardWizardModal
          client={scorecardClient}
          therapistName={user?.name || ''}
          discipline={lockedDiscipline}
          onClose={() => setScorecardClient(null)}
          toast={toast}
          onSubmitted={() => loadGasData(gasDiscipline)}
        />
      )}

      {gasArchiveConfirm && (
        <Modal title={<><i className="fa-solid fa-box-archive" style={{ color: '#B45309', marginRight: 8 }} />Archive GAS {gasArchiveConfirm.type === 'bulk' ? 'Entries' : 'Entry'}?</>} onClose={() => setGasArchiveConfirm(null)} width={440}>
          <div style={{ textAlign: 'center', padding: '10px 0 20px' }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, background: '#FEF9C3', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: 22, color: '#B45309' }}><i className="fa-solid fa-box-archive" /></div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 8 }}>
              {gasArchiveConfirm.type === 'bulk'
                ? `Archive ${gasArchiveConfirm.count} GAS entr${gasArchiveConfirm.count === 1 ? 'y' : 'ies'}?`
                : 'Archive this GAS entry?'}
            </div>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 24, lineHeight: 1.6 }}>
              {gasArchiveConfirm.type === 'bulk' ? 'Archived entries drop' : 'It drops'} off this list and out of progress charts, but stay{gasArchiveConfirm.type === 'bulk' ? '' : 's'} on record.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn-secondary" onClick={() => setGasArchiveConfirm(null)}>Cancel</button>
              <button
                style={{ padding: '9px 20px', borderRadius: 9, border: 'none', background: '#F59E0B', fontSize: 13, fontWeight: 600, color: '#fff', cursor: 'pointer' }}
                onClick={() => gasArchiveConfirm.type === 'bulk' ? doBulkArchiveGasEntries() : doArchiveGasEntry(gasArchiveConfirm.entry)}
              >
                Archive
              </button>
            </div>
          </div>
        </Modal>
      )}

      {gasEntryModal && gasEntryModal.mode === 'view' && (
        <Modal title="GAS Entry: View" onClose={closeGasEntryModal} width={620}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
            <div><div className="form-label">Entry ID</div><div style={{ fontSize: 11.5, color: '#64748B', fontFamily: 'monospace' }}>{gasEntryModal.entry.id}</div></div>
            <div><div className="form-label">Client ID</div><div style={{ fontSize: 11.5, color: '#64748B', fontFamily: 'monospace' }}>{gasEntryModal.entry.client?.client_code || gasEntryModal.entry.client_id}</div></div>
            <div><div className="form-label">Child</div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>{gasEntryModal.entry.client?.full_name || 'Unknown child'}</div><div style={{ fontSize: 11.5, color: '#94A3B8' }}>{gasEntryModal.entry.client?.client_code}</div></div>
            <div><div className="form-label">Discipline</div><div style={{ fontSize: 13.5, color: '#334155' }}>{gasEntryModal.entry.discipline}</div></div>
            <div><div className="form-label">Session Date</div><div style={{ fontSize: 13.5, color: '#334155' }}>{gasEntryModal.entry.session_date}</div></div>
            <div><div className="form-label">Therapist</div><div style={{ fontSize: 13.5, color: '#334155' }}>{gasEntryModal.entry.therapist_name || '-'}</div></div>
            <div><div className="form-label">GAS T-Score</div><span className={'pill pill-' + gasScoreTone(gasEntryModal.entry.gas_t_score)} style={{ fontSize: 13 }}>{gasEntryModal.entry.gas_t_score}</span></div>
          </div>
          {(() => {
            const { parentObservation, remarks } = splitGasRemarks(gasEntryModal.entry.remarks);
            return (
              <>
                {parentObservation && (
                  <div style={{ marginBottom: 18 }}>
                    <div className="form-label">Parent Observation</div>
                    <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6, whiteSpace: 'pre-wrap', padding: 10, borderRadius: 9, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>{parentObservation}</div>
                  </div>
                )}
                <div className="section-title" style={{ fontSize: 13, marginBottom: 8 }}>Goals Scored</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
                  {(gasEntryModal.entry.scores || []).map(s => (
                    <div key={s.id} style={{ padding: 12, borderRadius: 10, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Goal: {s.item_title}</div>
                        <span style={{ fontSize: 10.5, color: '#94A3B8', whiteSpace: 'nowrap' }}>weight ×{s.weight}</span>
                      </div>
                      <input type="range" min={-2} max={2} step={1} value={s.level} disabled className="gas-goal-slider" />
                      <div className="gas-slider-scale">
                        <span>[-2]</span><span>-1</span><span>0</span><span>+1</span><span>[+2]</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 11.5, color: '#334155', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 7, padding: '6px 9px' }}>
                        {s.level_label}
                      </div>
                    </div>
                  ))}
                </div>
                {remarks && (
                  <div style={{ marginBottom: 18 }}>
                    <div className="form-label">Remarks</div>
                    <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{remarks}</div>
                  </div>
                )}
              </>
            );
          })()}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn-secondary" onClick={closeGasEntryModal}>Close</button>
          </div>
        </Modal>
      )}

      {gasEntryModal && gasEntryModal.mode === 'edit' && (
        <Modal title="GAS Entry: Edit" onClose={closeGasEntryModal} width={620}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
            <div><div className="form-label">Child</div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>{gasEntryModal.entry.client?.full_name || 'Unknown child'}</div></div>
            <div><div className="form-label">Discipline</div><div style={{ fontSize: 13.5, color: '#334155' }}>{gasEntryModal.entry.discipline} · {gasEntryModal.entry.questionnaire_name}</div></div>
            <div><label className="form-label">Session Date *</label><input className="form-input" type="date" max={todayStr()} value={gasEditForm.session_date} onChange={e => setGasEditForm(f => ({ ...f, session_date: e.target.value }))} /></div>
            {/* An ot/speech account IS the therapist, nothing to pick, just show who it is. */}
            {lockedDiscipline ? (
              <div><div className="form-label">Therapist</div><div style={{ fontSize: 13.5, color: '#334155' }}>{gasEditForm.therapist_name || user?.name || '-'}</div></div>
            ) : (
            <div><label className="form-label">Therapist{gasEditAssignedTherapists.length ? ', assigned to this child' : ''}</label>
              <select className="form-select" value={gasEditForm.therapist_name} onChange={e => setGasEditForm(f => ({ ...f, therapist_name: e.target.value }))}>
                <option value="">- None -</option>
                {gasEditTherapistPool.map(t => <option key={t.therapist_id} value={t.name}>{t.name}</option>)}
                {gasEditForm.therapist_name && !gasEditTherapistPool.some(t => t.name === gasEditForm.therapist_name) && (
                  <option value={gasEditForm.therapist_name}>{gasEditForm.therapist_name}</option>
                )}
              </select>
            </div>
            )}
          </div>

          <div className="section-title" style={{ fontSize: 13, marginBottom: 8 }}>Re-score Goals</div>

          <div style={{ marginBottom: 14 }}><label className="form-label" style={{ marginBottom: 6, display: 'block' }}>Parent Observation</label>
            <textarea className="form-input" rows="3" style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }} placeholder="Parent observation text notes…" value={gasEditForm.parentObservation} onChange={e => setGasEditForm(f => ({ ...f, parentObservation: e.target.value }))} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto', paddingRight: 4, marginBottom: 14 }}>
            {(gasEntryModal.entry.scores || []).map(s => {
              const liveItem = s.item_id ? gasEditQuestionnaireItems.find(it => it.id === s.item_id) : null;
              const level = s.item_id ? gasEditScores[s.item_id] : s.level;
              const levelLabel = liveItem ? liveItem[GAS_LEVEL_FIELD[String(level)]] : (level === s.level ? s.level_label : null);
              return (
                <div key={s.id} style={{ padding: 12, borderRadius: 10, border: '1px solid #E2E8F0', background: '#FAFBFC' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Goal: {s.item_title}</div>
                    <span style={{ fontSize: 10.5, color: '#94A3B8', whiteSpace: 'nowrap' }}>weight ×{s.weight}</span>
                  </div>
                  {s.item_id ? (
                    <>
                      <input type="range" min={-2} max={2} step={1} value={level} className="gas-goal-slider"
                        onChange={e => setGasEditScores(prev => ({ ...prev, [s.item_id]: Number(e.target.value) }))} />
                      <div className="gas-slider-scale">
                        <span>[-2]</span><span>-1</span><span>0</span><span>+1</span><span>[+2]</span>
                      </div>
                      {levelLabel && (
                        <div style={{ marginTop: 8, fontSize: 11.5, color: '#334155', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 7, padding: '6px 9px' }}>
                          {levelLabel}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ fontSize: 11.5, color: '#94A3B8' }}>
                      Original goal was removed from the questionnaire, level locked at {s.level > 0 ? '+' + s.level : s.level} ({s.level_label})
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div><label className="form-label" style={{ marginBottom: 6, display: 'block' }}>Remarks</label>
            <textarea className="form-input" rows="3" style={{ height: 'auto', padding: '8px 12px', resize: 'vertical', marginBottom: 8 }} value={gasEditForm.remarks} onChange={e => setGasEditForm(f => ({ ...f, remarks: e.target.value }))} />
            <button className="btn-secondary" style={{ width: '100%' }} onClick={generateGasEditSummary}>
              <i className="fa-solid fa-file-lines" style={{ marginRight: 6 }} />Generate Summary
            </button>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
            <button className="btn-secondary" onClick={closeGasEntryModal}>Cancel</button>
            <button className="btn-primary" disabled={gasEditSaving} onClick={saveGasEdit}>
              <i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />{gasEditSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}

      {gasManageOpen && (
        <Modal
          title={gasManageSet ? `Edit Goals: ${gasManageSet.name}` : `Manage GAS Questionnaire Sets: ${gasDiscipline}`}
          onClose={() => { setGasManageOpen(false); setGasManageSetId(null); cancelEditGasItem(); }}
          width={760}
        >
          {!gasManageSet ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input className="form-input" placeholder="New questionnaire set name, e.g. v2" value={gasNewSetName} onChange={e => setGasNewSetName(e.target.value)} style={{ flex: 1 }} />
                <button className="btn-primary" onClick={createGasSet}><i className="fa-solid fa-plus" style={{ marginRight: 5 }} />New Set</button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th>Name</th><th>Status</th><th>Goals</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                  <tbody>
                    {gasCurrentSets.map(s => (
                      <tr key={s.id}>
                        <td>
                          {gasRenamingId === s.id ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <input className="form-input" style={{ height: 30, fontSize: 12.5 }} value={gasRenameValue} onChange={e => setGasRenameValue(e.target.value)} autoFocus />
                              <button className="btn-edit" onClick={() => saveGasSetRename(s)}>Save</button>
                              <button className="btn-edit" onClick={() => setGasRenamingId(null)}>Cancel</button>
                            </div>
                          ) : (
                            <span style={{ fontWeight: 600, color: '#0F172A' }}>{s.name}</span>
                          )}
                        </td>
                        <td><span className={'pill pill-' + (s.status === 'active' ? 'green' : s.status === 'archived' ? 'gray' : 'amber')}>{s.status}</span></td>
                        <td style={{ fontSize: 12.5 }}>{(s.items || []).length}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                            <button className="btn-edit" onClick={() => setGasManageSetId(s.id)}>Edit Goals</button>
                            <button className="btn-edit" onClick={() => { setGasRenamingId(s.id); setGasRenameValue(s.name); }}>Rename</button>
                            {s.status !== 'active' && <button className="btn-edit" onClick={() => setGasSetStatus(s, 'active')}>Activate</button>}
                            {s.status !== 'archived' && <button className="btn-edit" onClick={() => setGasSetStatus(s, 'archived')}>Archive</button>}
                            <button className="btn-danger" onClick={() => deleteGasSet(s)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!gasCurrentSets.length && (
                      <tr><td colSpan={4} style={{ textAlign: 'center', color: '#94A3B8', padding: '16px 0' }}>No questionnaire sets yet for {gasDiscipline}.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <button className="btn-secondary" style={{ marginBottom: 14 }} onClick={() => { setGasManageSetId(null); cancelEditGasItem(); }}>
                <i className="fa-solid fa-arrow-left" style={{ marginRight: 5 }} />Back to Sets
              </button>
              <div style={{ overflowX: 'auto', marginBottom: 18 }}>
                <table className="data-table">
                  <thead><tr><th>Goal</th><th>Weight</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
                  <tbody>
                    {(gasManageSet.items || []).map(it => (
                      <tr key={it.id}>
                        <td><div style={{ fontWeight: 600, color: '#0F172A' }}>{it.title}</div>{it.description && <div style={{ fontSize: 11, color: '#94A3B8' }}>{it.description}</div>}</td>
                        <td style={{ fontSize: 12.5 }}>{it.weight}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                            <button className="btn-edit" onClick={() => startEditGasItem(it)}>Edit</button>
                            <button className="btn-danger" onClick={() => deleteGasItem(gasManageSet.id, it.id)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!(gasManageSet.items || []).length && (
                      <tr><td colSpan={3} style={{ textAlign: 'center', color: '#94A3B8', padding: '16px 0' }}>No goals yet, add one below.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="section-title" style={{ fontSize: 13, marginBottom: 10 }}>{gasEditingItemId ? 'Edit Goal' : 'Add New Goal'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ gridColumn: '1/-1' }}><label className="form-label">Goal Title *</label><input className="form-input" value={gasItemDraft.title} onChange={e => setGasItemDraft(d => ({ ...d, title: e.target.value }))} /></div>
                <div style={{ gridColumn: '1/-1' }}><label className="form-label">Description</label><input className="form-input" value={gasItemDraft.description} onChange={e => setGasItemDraft(d => ({ ...d, description: e.target.value }))} /></div>
                <div><label className="form-label">-2, Much less than expected *</label><input className="form-input" value={gasItemDraft.level_m2} onChange={e => setGasItemDraft(d => ({ ...d, level_m2: e.target.value }))} /></div>
                <div><label className="form-label">-1, Somewhat less than expected *</label><input className="form-input" value={gasItemDraft.level_m1} onChange={e => setGasItemDraft(d => ({ ...d, level_m1: e.target.value }))} /></div>
                <div><label className="form-label">0, Expected level of outcome *</label><input className="form-input" value={gasItemDraft.level_0} onChange={e => setGasItemDraft(d => ({ ...d, level_0: e.target.value }))} /></div>
                <div><label className="form-label">+1, Somewhat more than expected *</label><input className="form-input" value={gasItemDraft.level_p1} onChange={e => setGasItemDraft(d => ({ ...d, level_p1: e.target.value }))} /></div>
                <div><label className="form-label">+2, Much more than expected *</label><input className="form-input" value={gasItemDraft.level_p2} onChange={e => setGasItemDraft(d => ({ ...d, level_p2: e.target.value }))} /></div>
                <div><label className="form-label">Weight</label><input className="form-input" type="number" min="0.1" step="0.1" value={gasItemDraft.weight} onChange={e => setGasItemDraft(d => ({ ...d, weight: e.target.value }))} /></div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                {gasEditingItemId && <button className="btn-secondary" onClick={cancelEditGasItem}>Cancel Edit</button>}
                <button className="btn-primary" onClick={() => saveGasItem(gasManageSet.id)}>
                  <i className="fa-solid fa-check" style={{ marginRight: 5 }} />{gasEditingItemId ? 'Save Goal' : 'Add Goal'}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

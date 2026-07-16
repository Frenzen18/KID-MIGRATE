import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

const DISCIPLINES = ['Speech-Language Therapy', 'Occupational Therapy'];
const ITEM_FIELDS = ['title', 'description', 'level_m2', 'level_m1', 'level_0', 'level_p1', 'level_p2', 'weight', 'sort_order'];
const LEVEL_KEY = { '-2': 'level_m2', '-1': 'level_m1', '0': 'level_0', '1': 'level_p1', '2': 'level_p2' };
const ROLE_DISCIPLINE = { ot: 'Occupational Therapy', speech: 'Speech-Language Therapy' };

/** Today's date (YYYY-MM-DD) in Philippine time (UTC+8), a GAS entry scores a session that
 *  already happened, so its date can never be in the future. Mirrors reservations.js's todayPH(). */
function todayPH() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * An 'ot' or 'speech' account may only submit/edit GAS entries for their own discipline,  * hiding the other tab client-side isn't enough, since this is the actual write path.
 * Admin/staff pass through unrestricted.
 */
function assertDisciplineAccess(user, discipline) {
  const locked = ROLE_DISCIPLINE[user.role];
  if (locked && locked !== discipline) {
    return `Your account is restricted to ${locked} GAS entries.`;
  }
  return null;
}

/** Kiresuk & Sherman GAS T-score; rho = 0.3 is the standard assumed average intercorrelation among goal scales. */
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

/** GET /api/gas/questionnaires?discipline=&status=, goal sets with their items, newest first */
router.get('/questionnaires', async (req, res) => {
  let q = db.from('gas_questionnaires').select('*').order('created_at', { ascending: false });
  if (req.query.discipline) q = q.eq('discipline', req.query.discipline);
  if (req.query.status) q = q.eq('status', req.query.status);
  const { data: sets, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  if (!sets.length) return res.json([]);

  const { data: items, error: iErr } = await db.from('gas_questionnaire_items').select('*')
    .in('questionnaire_id', sets.map(s => s.id)).order('sort_order', { ascending: true });
  if (iErr) return res.status(500).json({ error: iErr.message });

  const byQuestionnaire = {};
  for (const it of items || []) (byQuestionnaire[it.questionnaire_id] ||= []).push(it);
  res.json(sets.map(s => ({ ...s, items: byQuestionnaire[s.id] || [] })));
});

/** GET /api/gas/questionnaires/:id */
router.get('/questionnaires/:id', async (req, res) => {
  const { data: set, error } = await db.from('gas_questionnaires').select('*').eq('id', req.params.id).single();
  if (error || !set) return res.status(404).json({ error: 'Questionnaire not found' });
  const { data: items } = await db.from('gas_questionnaire_items').select('*').eq('questionnaire_id', set.id).order('sort_order', { ascending: true });
  res.json({ ...set, items: items || [] });
});

/** POST /api/gas/questionnaires, admin creates a new versioned goal set (starts as draft) */
router.post('/questionnaires', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.discipline) return res.status(400).json({ error: 'name and discipline are required' });
  if (!DISCIPLINES.includes(b.discipline)) return res.status(400).json({ error: 'invalid discipline' });

  const { data, error } = await db.from('gas_questionnaires').insert({
    discipline: b.discipline, name: b.name, status: 'draft', created_by: req.user.id
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'gas_questionnaires', record_id: data.id, action: 'create',
    description: `Created GAS questionnaire "${data.name}" (${data.discipline})`,
    created_by: req.user.id
  });

  res.status(201).json({ ...data, items: [] });
});

/** PUT /api/gas/questionnaires/:id, rename, activate, or archive a goal set */
router.put('/questionnaires/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['name', 'status']) if (k in b) patch[k] = b[k];
  if (patch.status && !['draft', 'active', 'archived'].includes(patch.status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const { data, error } = await db.from('gas_questionnaires').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'gas_questionnaires', record_id: req.params.id, action: 'update',
    description: `Updated GAS questionnaire "${data.name}"` + (patch.status ? `, status set to ${patch.status}` : ''),
    updated_by: req.user.id
  });

  res.json(data);
});

/** DELETE /api/gas/questionnaires/:id, items cascade; past entries keep their own snapshot */
router.delete('/questionnaires/:id', requireRole('admin'), async (req, res) => {
  const { data: existing } = await db.from('gas_questionnaires').select('name').eq('id', req.params.id).maybeSingle();
  const { error } = await db.from('gas_questionnaires').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'gas_questionnaires', record_id: req.params.id, action: 'delete',
    description: `Deleted GAS questionnaire${existing?.name ? ' "' + existing.name + '"' : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

/** POST /api/gas/questionnaires/:id/items, admin adds a goal (5 outcome levels + weight) to a set */
router.post('/questionnaires/:id/items', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  for (const k of ['title', 'level_m2', 'level_m1', 'level_0', 'level_p1', 'level_p2']) {
    if (!b[k]) return res.status(400).json({ error: `${k} is required` });
  }

  const row = {
    questionnaire_id: req.params.id,
    title: b.title, description: b.description || null,
    level_m2: b.level_m2, level_m1: b.level_m1, level_0: b.level_0, level_p1: b.level_p1, level_p2: b.level_p2,
    weight: Number(b.weight) > 0 ? Number(b.weight) : 1,
    sort_order: Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 0
  };
  const { data, error } = await db.from('gas_questionnaire_items').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'gas_questionnaire_items', record_id: data.id, action: 'create',
    description: `Added GAS goal "${data.title}" to questionnaire ${req.params.id}`,
    created_by: req.user.id
  });

  res.status(201).json(data);
});

/** PUT /api/gas/items/:id, admin edits a goal's title/description/levels/weight/order */
router.put('/items/:id', requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ITEM_FIELDS) if (k in b) patch[k] = b[k];
  if ('weight' in patch) patch.weight = Number(patch.weight) > 0 ? Number(patch.weight) : 1;

  const { data, error } = await db.from('gas_questionnaire_items').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'gas_questionnaire_items', record_id: req.params.id, action: 'update',
    description: `Updated GAS goal "${data.title}"`,
    updated_by: req.user.id
  });

  res.json(data);
});

/** DELETE /api/gas/items/:id */
router.delete('/items/:id', requireRole('admin'), async (req, res) => {
  const { data: existing } = await db.from('gas_questionnaire_items').select('title').eq('id', req.params.id).maybeSingle();
  const { error } = await db.from('gas_questionnaire_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'gas_questionnaire_items', record_id: req.params.id, action: 'delete',
    description: `Deleted GAS goal${existing?.title ? ' "' + existing.title + '"' : ''}`,
    updated_by: req.user.id
  });

  res.json({ ok: true });
});

/** GET /api/gas/entries?client_id=&discipline=&archived=, submitted assessments with their per-goal scores */
router.get('/entries', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  let q = db.from('gas_entries').select('*').order('session_date', { ascending: false });
  if (req.query.client_id) q = q.eq('client_id', req.query.client_id);
  if (req.query.discipline) q = q.eq('discipline', req.query.discipline);
  q = q.eq('archived', req.query.archived === 'true');
  const { data: entries, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  if (!entries.length) return res.json([]);

  const [{ data: scores }, { data: clients }] = await Promise.all([
    db.from('gas_entry_scores').select('*').in('entry_id', entries.map(e => e.id)),
    db.from('clients').select('id, full_name, client_code').in('id', [...new Set(entries.map(e => e.client_id))])
  ]);
  const scoresByEntry = {};
  for (const s of scores || []) (scoresByEntry[s.entry_id] ||= []).push(s);
  const clientById = {};
  for (const c of clients || []) clientById[c.id] = c;

  res.json(entries.map(e => ({ ...e, scores: scoresByEntry[e.id] || [], client: clientById[e.client_id] || null })));
});

/** POST /api/gas/entries, score a client's session against a questionnaire and compute the GAS T-score */
router.post('/entries', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const b = req.body || {};
  if (!b.client_id || !b.questionnaire_id || !b.session_date) {
    return res.status(400).json({ error: 'client_id, questionnaire_id, and session_date are required' });
  }
  if (b.session_date > todayPH()) {
    return res.status(400).json({ error: 'Session date cannot be in the future, a GAS entry scores a session that already happened.' });
  }
  const rawScores = Array.isArray(b.scores) ? b.scores : [];
  if (!rawScores.length) return res.status(400).json({ error: 'At least one goal score is required' });

  const { data: set, error: setErr } = await db.from('gas_questionnaires').select('*').eq('id', b.questionnaire_id).single();
  if (setErr || !set) return res.status(404).json({ error: 'Questionnaire not found' });

  const disciplineErr = assertDisciplineAccess(req.user,set.discipline);
  if (disciplineErr) return res.status(403).json({ error: disciplineErr });

  const { data: items, error: itemsErr } = await db.from('gas_questionnaire_items').select('*').eq('questionnaire_id', set.id);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });
  const itemById = {};
  for (const it of items || []) itemById[it.id] = it;

  // Weights and level text are re-derived from the stored goal, never trusted from the client,
  // so a stale/tampered payload can't skew the score or record the wrong outcome text.
  const snapshotScores = [];
  for (const s of rawScores) {
    const item = itemById[s.item_id];
    const level = Number(s.level);
    if (!item || !Number.isInteger(level) || level < -2 || level > 2) {
      return res.status(400).json({ error: 'Each score must reference a valid goal in this questionnaire with a level between -2 and 2' });
    }
    snapshotScores.push({
      item_id: item.id, item_title: item.title, weight: item.weight, level,
      level_label: item[LEVEL_KEY[String(level)]]
    });
  }

  const gasScore = computeGasTScore(snapshotScores);

  const { data: entry, error: entryErr } = await db.from('gas_entries').insert({
    client_id: b.client_id, questionnaire_id: set.id, discipline: set.discipline,
    questionnaire_name: set.name, session_date: b.session_date,
    therapist_name: b.therapist_name || null, remarks: b.remarks || null,
    gas_t_score: gasScore, created_by: req.user.id
  }).select().single();
  if (entryErr) return res.status(500).json({ error: entryErr.message });

  const { data: scoreRows, error: scoreErr } = await db.from('gas_entry_scores')
    .insert(snapshotScores.map(s => ({ ...s, entry_id: entry.id }))).select();
  if (scoreErr) return res.status(500).json({ error: scoreErr.message });

  await logAudit({
    table_name: 'gas_entries', record_id: entry.id, action: 'create',
    description: `Submitted GAS assessment (${set.discipline}) for client ${b.client_id}, T-score ${gasScore}`,
    created_by: req.user.id
  });

  const { data: client } = await db.from('clients').select('parent_id, full_name').eq('id', b.client_id).maybeSingle();
  if (client?.parent_id) {
    await notifyEvent('notify_scorecard_submitted', {
      title: 'New progress scorecard',
      body: `A new ${set.discipline} scorecard was submitted for ${client.full_name || 'your child'} (session ${b.session_date}).`,
      icon: 'fa-child',
      target_user: client.parent_id
    });
  }

  res.status(201).json({ ...entry, scores: scoreRows || [] });
});

/** PUT /api/gas/entries/:id, edit an already-submitted assessment (date/therapist/remarks and/or re-score its goals) */
router.put('/entries/:id', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const b = req.body || {};
  const { data: entry, error: eErr } = await db.from('gas_entries').select('*').eq('id', req.params.id).single();
  if (eErr || !entry) return res.status(404).json({ error: 'Entry not found' });

  const disciplineErr = assertDisciplineAccess(req.user,entry.discipline);
  if (disciplineErr) return res.status(403).json({ error: disciplineErr });

  if ('session_date' in b && b.session_date > todayPH()) {
    return res.status(400).json({ error: 'Session date cannot be in the future, a GAS entry scores a session that already happened.' });
  }

  const patch = {};
  for (const k of ['session_date', 'therapist_name', 'remarks']) if (k in b) patch[k] = b[k];

  let snapshotScores = null;
  if (Array.isArray(b.scores) && b.scores.length) {
    const { data: items, error: itemsErr } = await db.from('gas_questionnaire_items').select('*').eq('questionnaire_id', entry.questionnaire_id);
    if (itemsErr) return res.status(500).json({ error: itemsErr.message });
    const itemById = {};
    for (const it of items || []) itemById[it.id] = it;

    snapshotScores = [];
    for (const s of b.scores) {
      const item = itemById[s.item_id];
      const level = Number(s.level);
      if (!item || !Number.isInteger(level) || level < -2 || level > 2) {
        return res.status(400).json({ error: 'Each score must reference a valid goal in this questionnaire with a level between -2 and 2' });
      }
      snapshotScores.push({
        item_id: item.id, item_title: item.title, weight: item.weight, level,
        level_label: item[LEVEL_KEY[String(level)]]
      });
    }
    patch.gas_t_score = computeGasTScore(snapshotScores);
  }

  const { data: updated, error: uErr } = await db.from('gas_entries').update(patch).eq('id', entry.id).select().single();
  if (uErr) return res.status(500).json({ error: uErr.message });

  let scoreRows;
  if (snapshotScores) {
    const { error: delErr } = await db.from('gas_entry_scores').delete().eq('entry_id', entry.id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    const { data: inserted, error: insErr } = await db.from('gas_entry_scores')
      .insert(snapshotScores.map(s => ({ ...s, entry_id: entry.id }))).select();
    if (insErr) return res.status(500).json({ error: insErr.message });
    scoreRows = inserted;
  } else {
    const { data: existingScores } = await db.from('gas_entry_scores').select('*').eq('entry_id', entry.id);
    scoreRows = existingScores || [];
  }

  await logAudit({
    table_name: 'gas_entries', record_id: entry.id, action: 'update',
    description: `Updated GAS assessment (${entry.discipline})` + (patch.gas_t_score != null ? `, T-score now ${patch.gas_t_score}` : ''),
    updated_by: req.user.id
  });

  res.json({ ...updated, scores: scoreRows });
});

/** DELETE /api/gas/entries/:id, archive a submitted GAS assessment (soft delete, scores are kept) */
router.delete('/entries/:id', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const { data: entry, error: eErr } = await db.from('gas_entries').select('*').eq('id', req.params.id).single();
  if (eErr || !entry) return res.status(404).json({ error: 'Entry not found' });

  const disciplineErr = assertDisciplineAccess(req.user,entry.discipline);
  if (disciplineErr) return res.status(403).json({ error: disciplineErr });

  const { error: archErr } = await db.from('gas_entries').update({ archived: true }).eq('id', entry.id);
  if (archErr) return res.status(500).json({ error: archErr.message });

  await logAudit({
    table_name: 'gas_entries', record_id: entry.id, action: 'archive',
    description: `Archived GAS assessment (${entry.discipline}) for client ${entry.client_id}`,
    updated_by: req.user.id
  });

  res.json({ success: true });
});

export default router;

/**
 * One-off migration: reassigns every existing role='therapist' profile to
 * 'ot' or 'speech', inferred from real session history (gas_entries first,
 * then reservations, then session_notes). Accounts with no clear signal
 * default to 'ot' and print a warning so an admin can manually correct them
 * via User Management afterward.
 *
 * Run AFTER supabase/migration_role_ot_speech_step1_widen.sql (widens the
 * constraint so 'ot'/'speech' can be written) and BEFORE
 * supabase/migration_role_ot_speech_step2_tighten.sql (removes 'therapist'
 * from the allowed values, any row still holding it would fail that step).
 *
 *   node scripts/migrate-therapist-roles.mjs
 */
import { db } from '../supabase.js';

// Mirrors server/routes/analytics.js's isOT/isSpeech, same classification
// the rest of the app already uses for session_type free text.
const isOT = t => /occupational|\bOT\b/i.test(t || '');
const isSpeech = t => /speech/i.test(t || '');

async function inferDiscipline(profile) {
  // 1) Cleanest signal: gas_entries.discipline is an exact enum value.
  const { data: gas } = await db.from('gas_entries').select('discipline').eq('therapist_name', profile.full_name);
  if (gas?.length) {
    const ot = gas.filter(g => g.discipline === 'Occupational Therapy').length;
    const sp = gas.filter(g => g.discipline === 'Speech-Language Therapy').length;
    if (ot > sp) return 'ot';
    if (sp > ot) return 'speech';
  }

  // 2) reservations.session_type on real (non-cancelled/declined) bookings.
  const { data: res } = await db.from('reservations').select('session_type,status').eq('therapist_name', profile.full_name);
  const active = (res || []).filter(r => !['cancelled', 'declined'].includes(r.status));
  const otCount = active.filter(r => isOT(r.session_type)).length;
  const spCount = active.filter(r => isSpeech(r.session_type)).length;
  if (otCount > spCount) return 'ot';
  if (spCount > otCount) return 'speech';

  // 3) session_notes.domain as a last resort.
  const { data: notes } = await db.from('session_notes').select('domain').eq('therapist_name', profile.full_name);
  const noteOt = (notes || []).filter(n => !isSpeech(n.domain)).length;
  const noteSp = (notes || []).filter(n => isSpeech(n.domain)).length;
  if (noteOt > noteSp) return 'ot';
  if (noteSp > noteOt) return 'speech';

  return null; // no clear signal, including a tie or zero data
}

async function main() {
  const { data: therapists, error } = await db.from('profiles').select('id, full_name').eq('role', 'therapist');
  if (error) throw new Error('fetch therapists: ' + error.message);
  if (!therapists?.length) { console.log('No role=therapist profiles found, nothing to do.'); return; }

  for (const p of therapists) {
    let newRole = await inferDiscipline(p);
    if (!newRole) {
      newRole = 'ot';
      console.warn(`WARNING: could not confidently infer discipline for "${p.full_name}" (${p.id}), defaulted to 'ot'. Please verify/correct via User Management.`);
    }

    const { error: pErr } = await db.from('profiles').update({ role: newRole }).eq('id', p.id);
    if (pErr) { console.error(`Failed to update profiles.role for ${p.full_name}:`, pErr.message); continue; }

    const { error: aErr } = await db.auth.admin.updateUserById(p.id, { app_metadata: { role: newRole } });
    if (aErr) { console.error(`Failed to update app_metadata.role for ${p.full_name}:`, aErr.message); continue; }

    console.log(`${p.full_name} (${p.id}) -> role='${newRole}'`);
  }
  console.log('\nDone. Now run supabase/migration_role_ot_speech_step2_tighten.sql to tighten the role constraint and drop specialty.');
}

main().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });

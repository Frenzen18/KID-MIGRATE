import { db } from '../supabase.js';
import { notifyEvent, channelEnabled } from './notify.js';
import { sendMail } from '../mailer.js';
import { logAudit } from './audit.js';

const WARNING_MS = 6 * 7 * 24 * 60 * 60 * 1000; // ~6 weeks
const DELETE_MS = 60 * 24 * 60 * 60 * 1000; // ~2 months

/**
 * Closes the "spam signup" gap: a guardian account that never books an
 * Initial Assessment is just as easy to mass-create as a real one, and
 * nothing currently distinguishes them. Booking AND paying for an IA pauses
 * the clock entirely (there's a real appointment on the books, nothing to
 * flag); once staff resolves that IA, Completed exempts the account for
 * good, No-Show resumes the clock from that session's own date (reusing the
 * existing Completed/No-Show marking, see SlotActionsModal.jsx, no separate
 * toggle needed). An account with ANY booking history at all beyond this is
 * simply never a candidate in the first place, this only ever targets a
 * guardian who has done nothing since signing up.
 */
export async function sweepInactiveAccounts() {
  try {
    const { data: parents, error } = await db.from('profiles')
      .select('id, full_name, email, created_at, deletion_warning_sent_at, deletion_flagged_at, deletion_exempt')
      .eq('role', 'parent').eq('active', true);
    if (error) { console.error('sweepInactiveAccounts: query failed:', error.message); return; }

    let newlyFlaggedCount = 0;
    for (const profile of parents || []) {
      if (profile.deletion_exempt) continue;
      try {
        if (await evaluateAccount(profile)) newlyFlaggedCount++;
      } catch (e) {
        console.error('sweepInactiveAccounts: per-account error for', profile.id, ':', e.message);
      }
    }

    if (newlyFlaggedCount > 0) {
      const body = `${newlyFlaggedCount} guardian account${newlyFlaggedCount > 1 ? 's have' : ' has'} never booked an Initial Assessment and been inactive for 2 months. Review before removal in User Management.`;
      await notifyEvent(null, { title: 'Inactive accounts flagged for cleanup review', body, icon: 'fa-user-slash', target_role: 'admin' });
      await notifyEvent(null, { title: 'Inactive accounts flagged for cleanup review', body, icon: 'fa-user-slash', target_role: 'staff' });
    }
  } catch (e) {
    console.error('sweepInactiveAccounts failed:', e.message);
  }
}

/** Evaluates one guardian account's current state and updates its
 *  warning/flag columns accordingly. Returns true only when this run is
 *  what newly flagged it for review (used to batch the admin notification). */
async function evaluateAccount(profile) {
  const { data: clients } = await db.from('clients').select('id').eq('parent_id', profile.id);
  const clientIds = (clients || []).map(c => c.id);

  let iaRows = [];
  if (clientIds.length) {
    const { data } = await db.from('reservations')
      .select('id, status, date').in('client_id', clientIds).eq('session_type', 'Initial Assessment');
    iaRows = data || [];
  }

  // Ever actually shown up to an Initial Assessment: exempt for good, no
  // matter what the account does or doesn't do afterward.
  if (iaRows.some(r => r.status === 'completed')) {
    await clearFlags(profile, { alsoExempt: true });
    return false;
  }

  // A real appointment is currently booked and paid for, waiting on its own
  // date (or on staff to resolve it after the fact) - never a candidate
  // while that's true, resolving it either exempts it (Completed) or hands
  // it back to the clock below (No-Show).
  const pendingIaIds = iaRows.filter(r => ['confirmed', 'rescheduled'].includes(r.status)).map(r => r.id);
  if (pendingIaIds.length) {
    const { data: paid } = await db.from('payments').select('id').eq('status', 'paid').in('reservation_id', pendingIaIds).limit(1);
    if (paid?.length) {
      await clearFlags(profile);
      return false;
    }
  }

  // Counting. Reference point is account creation, or the date of the most
  // recent No-Show'd Initial Assessment if that's later, either way this is
  // "how long has this account gone without ever completing one."
  let referenceMs = new Date(profile.created_at).getTime();
  for (const r of iaRows) {
    if (r.status !== 'no_show') continue;
    const ms = new Date(r.date + 'T00:00:00Z').getTime();
    if (ms > referenceMs) referenceMs = ms;
  }
  const elapsedMs = Date.now() - referenceMs;

  if (elapsedMs >= DELETE_MS) {
    if (!profile.deletion_flagged_at) {
      await db.from('profiles').update({ deletion_flagged_at: new Date().toISOString() }).eq('id', profile.id);
      return true;
    }
    return false;
  }

  if (elapsedMs >= WARNING_MS) {
    // Was flagged from an earlier stretch of counting that's since paused
    // and resumed at a later reference point, no longer actually past the
    // 2-month mark, un-flag it.
    if (profile.deletion_flagged_at) await db.from('profiles').update({ deletion_flagged_at: null }).eq('id', profile.id);
    if (!profile.deletion_warning_sent_at) {
      await sendInactivityWarning(profile);
      await db.from('profiles').update({ deletion_warning_sent_at: new Date().toISOString() }).eq('id', profile.id);
    }
    return false;
  }

  // Under 6 weeks since the (possibly just-reset) reference point, clear any
  // stale warning/flag left over from before it reset.
  await clearFlags(profile);
  return false;
}

async function clearFlags(profile, { alsoExempt = false } = {}) {
  if (!profile.deletion_flagged_at && !profile.deletion_warning_sent_at && !alsoExempt) return;
  const patch = { deletion_flagged_at: null, deletion_warning_sent_at: null };
  if (alsoExempt) patch.deletion_exempt = true;
  await db.from('profiles').update(patch).eq('id', profile.id);
}

async function sendInactivityWarning(profile) {
  const body = `Your account hasn't booked an Initial Assessment yet. Book one soon, accounts inactive for 2 months with no Initial Assessment are reviewed for removal.`;
  if (await channelEnabled('channel_in_app')) {
    await notifyEvent(null, { title: 'Book an Initial Assessment to keep your account', body, icon: 'fa-hourglass-half', target_user: profile.id });
  }
  if (profile.email && await channelEnabled('channel_email')) {
    await sendMail({
      to: profile.email,
      subject: 'Book an Initial Assessment to keep your account active',
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
            <p style="color: #64748B; font-size: 13px;">Pediatric Speech &amp; Occupational Therapy</p>
          </div>
          <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px;">
            <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${profile.full_name || 'there'},</p>
            <p style="color: #64748B; font-size: 13px; margin: 0 0 16px; line-height: 1.7;">${body}</p>
            <p style="color: #64748B; font-size: 13px; margin: 0; line-height: 1.7;">
              Please log in to your Guardian Portal and book a session to keep your account active.
            </p>
          </div>
        </div>
      `
    }).catch(e => console.error('Inactivity warning email failed:', e.message));
  }
}

/** Admin-confirmed hard delete of a flagged account, never automatic. Removes
 *  every client/child record it created (cascades their reservations,
 *  payments, GAS entries per the schema's own FKs), then the auth user
 *  itself, so nothing unused is left cluttering the system. */
export async function deleteInactiveAccount(profileId, actorId) {
  const { data: profile } = await db.from('profiles').select('full_name, email').eq('id', profileId).maybeSingle();
  const { data: clients } = await db.from('clients').select('id, full_name').eq('parent_id', profileId);
  for (const c of clients || []) {
    await db.from('clients').delete().eq('id', c.id);
  }
  const { error } = await db.auth.admin.deleteUser(profileId);
  if (error) throw new Error(error.message);
  await logAudit({
    table_name: 'profiles', record_id: profileId, action: 'delete',
    description: `Inactive account deleted (${profile?.full_name || profile?.email || profileId}, never booked an Initial Assessment), ${(clients || []).length} linked child record(s) removed`,
    created_by: actorId
  });
}

/**
 * Per-child companion to sweepInactiveAccounts above. A guardian with several
 * linked children is only ever exempted at the account/login level once ANY
 * one of them completes an Initial Assessment - that alone isn't enough for
 * a sibling who's individually gone 2 months without ever completing their
 * own. Same pause/exempt/resume rules as the account-level sweep (paid
 * pending IA pauses, Completed exempts that child for good, No-Show resumes
 * the clock), just scoped to one child's own reservations instead of every
 * child a guardian has. Deleting a flagged child never touches the guardian's
 * login or any other linked child.
 */
export async function sweepInactiveChildren() {
  try {
    const { data: children, error } = await db.from('clients')
      .select('id, full_name, parent_id, created_at, deletion_warning_sent_at, deletion_flagged_at, deletion_exempt')
      .not('parent_id', 'is', null);
    if (error) { console.error('sweepInactiveChildren: query failed:', error.message); return; }

    let newlyFlaggedCount = 0;
    for (const child of children || []) {
      if (child.deletion_exempt) continue;
      try {
        if (await evaluateChild(child)) newlyFlaggedCount++;
      } catch (e) {
        console.error('sweepInactiveChildren: per-child error for', child.id, ':', e.message);
      }
    }

    if (newlyFlaggedCount > 0) {
      const body = `${newlyFlaggedCount} linked child${newlyFlaggedCount > 1 ? 'ren have' : ' has'} never completed an Initial Assessment and been inactive for 2 months. Review before removal in Client Records.`;
      await notifyEvent(null, { title: 'Inactive child records flagged for cleanup review', body, icon: 'fa-user-slash', target_role: 'admin' });
      await notifyEvent(null, { title: 'Inactive child records flagged for cleanup review', body, icon: 'fa-user-slash', target_role: 'staff' });
    }
  } catch (e) {
    console.error('sweepInactiveChildren failed:', e.message);
  }
}

async function evaluateChild(client) {
  const { data: iaRows } = await db.from('reservations')
    .select('id, status, date').eq('client_id', client.id).eq('session_type', 'Initial Assessment');
  const rows = iaRows || [];

  if (rows.some(r => r.status === 'completed')) {
    await clearChildFlags(client, { alsoExempt: true });
    return false;
  }

  const pendingIaIds = rows.filter(r => ['confirmed', 'rescheduled'].includes(r.status)).map(r => r.id);
  if (pendingIaIds.length) {
    const { data: paid } = await db.from('payments').select('id').eq('status', 'paid').in('reservation_id', pendingIaIds).limit(1);
    if (paid?.length) {
      await clearChildFlags(client);
      return false;
    }
  }

  let referenceMs = new Date(client.created_at).getTime();
  for (const r of rows) {
    if (r.status !== 'no_show') continue;
    const ms = new Date(r.date + 'T00:00:00Z').getTime();
    if (ms > referenceMs) referenceMs = ms;
  }
  const elapsedMs = Date.now() - referenceMs;

  if (elapsedMs >= DELETE_MS) {
    if (!client.deletion_flagged_at) {
      await db.from('clients').update({ deletion_flagged_at: new Date().toISOString() }).eq('id', client.id);
      return true;
    }
    return false;
  }

  if (elapsedMs >= WARNING_MS) {
    if (client.deletion_flagged_at) await db.from('clients').update({ deletion_flagged_at: null }).eq('id', client.id);
    if (!client.deletion_warning_sent_at) {
      await sendChildInactivityWarning(client);
      await db.from('clients').update({ deletion_warning_sent_at: new Date().toISOString() }).eq('id', client.id);
    }
    return false;
  }

  await clearChildFlags(client);
  return false;
}

async function clearChildFlags(client, { alsoExempt = false } = {}) {
  if (!client.deletion_flagged_at && !client.deletion_warning_sent_at && !alsoExempt) return;
  const patch = { deletion_flagged_at: null, deletion_warning_sent_at: null };
  if (alsoExempt) patch.deletion_exempt = true;
  await db.from('clients').update(patch).eq('id', client.id);
}

async function sendChildInactivityWarning(client) {
  if (!client.parent_id) return;
  const { data: guardian } = await db.from('profiles').select('full_name, email').eq('id', client.parent_id).maybeSingle();
  const body = `${client.full_name}'s Initial Assessment hasn't been completed yet. Book one soon, a linked child inactive for 2 months with no completed Initial Assessment is reviewed for removal.`;
  if (await channelEnabled('channel_in_app')) {
    await notifyEvent(null, { title: 'Book an Initial Assessment to keep this child active', body, icon: 'fa-hourglass-half', target_user: client.parent_id });
  }
  if (guardian?.email && await channelEnabled('channel_email')) {
    await sendMail({
      to: guardian.email,
      subject: 'Book an Initial Assessment to keep ' + client.full_name + "'s record active",
      html: `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
            <p style="color: #64748B; font-size: 13px;">Pediatric Speech &amp; Occupational Therapy</p>
          </div>
          <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px;">
            <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${guardian.full_name || 'there'},</p>
            <p style="color: #64748B; font-size: 13px; margin: 0 0 16px; line-height: 1.7;">${body}</p>
            <p style="color: #64748B; font-size: 13px; margin: 0; line-height: 1.7;">
              Please log in to your Guardian Portal and book a session to keep this record active.
            </p>
          </div>
        </div>
      `
    }).catch(e => console.error('Child inactivity warning email failed:', e.message));
  }
}

/** Admin-confirmed hard delete of one flagged child record, never automatic.
 *  Only ever removes this one client (cascades its own reservations,
 *  payments, GAS entries), the guardian's login and any other linked child
 *  are untouched. */
export async function deleteInactiveChild(clientId, actorId) {
  const { data: client } = await db.from('clients').select('full_name').eq('id', clientId).maybeSingle();
  if (!client) throw new Error('Client not found');
  const { error } = await db.from('clients').delete().eq('id', clientId);
  if (error) throw new Error(error.message);
  await logAudit({
    table_name: 'clients', record_id: clientId, action: 'delete',
    description: `Inactive child record deleted (${client.full_name}, never completed an Initial Assessment)`,
    created_by: actorId
  });
}

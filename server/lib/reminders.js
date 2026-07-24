import { db } from '../supabase.js';
import { notifyEvent, channelEnabled, therapistUserId } from './notify.js';
import { sendSms } from '../sms.js';

/** "h:mm AM/PM" + a date -> epoch ms, treating the pair as Philippine local time (UTC+8, no DST). */
export function sessionStartMs(dateStr, timeLabel) {
  const m = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(String(timeLabel || '').trim());
  if (!m) return null;
  let [, h, min, ap] = m;
  h = parseInt(h, 10) % 12;
  if (/pm/i.test(ap)) h += 12;
  return Date.parse(`${dateStr}T00:00:00Z`) + (h * 60 + parseInt(min, 10)) * 60 * 1000 - 8 * 60 * 60 * 1000;
}

/** Notifies (in-app + SMS, per the current channel settings) the guardian of one already-fetched reservation row. */
async function notifySessionReminderRow(r, settings) {
  const parentId = r.clients?.parent_id;
  if (!parentId) return;
  const childName = r.clients?.full_name || 'Your child';
  const when = `${r.date} at ${r.time_slot}${r.therapist_name ? ' with ' + r.therapist_name : ''}`;
  if (settings.channel_in_app !== false) {
    await notifyEvent(null, {
      title: 'Upcoming session reminder',
      body: `${childName}'s ${r.session_type} session is on ${when}.`,
      icon: 'fa-calendar-day',
      target_user: parentId
    });
  }
  const guardian = r.clients?.guardian;
  if (settings.channel_sms !== false && guardian?.contact) {
    const greeting = guardian.full_name ? `Hi ${guardian.full_name}! ` : 'Hi! ';
    sendSms({
      to: guardian.contact,
      message: `${greeting}Reminder: ${childName}'s ${r.session_type} is on ${when}. KID Clinic`
    }).catch(e => console.error('Session reminder SMS failed:', e.message));
  }
}

/** Notifies (in-app + SMS, per the current channel settings) the guardian of one already-fetched payment row. */
async function notifyBalanceReminderRow(p, settings) {
  const parentId = p.clients?.parent_id;
  if (!parentId) return;
  const childName = p.clients?.full_name || 'Your child';
  const amountLabel = '₱' + Number(p.amount).toLocaleString();
  if (settings.channel_in_app !== false) {
    await notifyEvent('notify_balance_reminder', {
      title: 'Outstanding balance reminder',
      body: `${childName} has an unpaid balance of ${amountLabel}.`,
      icon: 'fa-peso-sign',
      target_user: parentId
    });
  }
  const guardian = p.clients?.guardian;
  if (settings.channel_sms !== false && guardian?.contact) {
    const greeting = guardian.full_name ? `Hi ${guardian.full_name}! ` : 'Hi! ';
    sendSms({
      to: guardian.contact,
      message: `${greeting}${childName} has an unpaid balance of ${amountLabel}. Please settle at your earliest convenience. KID Clinic`
    }).catch(e => console.error('Balance reminder SMS failed:', e.message));
  }
}

/**
 * Sends the one-time "your session is coming up" reminder once a reservation
 * enters the configured lead-time window. `reminder_sent_at` makes each
 * reservation eligible exactly once, so re-running the sweep never re-sends.
 */
async function sendSessionReminders(settings) {
  if (settings.notify_session_reminder === false) return;
  if (settings.channel_in_app === false && settings.channel_sms === false) return;
  const leadMs = (settings.session_reminder_lead_hours || 24) * 60 * 60 * 1000;
  const now = Date.now();
  // Widen the date filter a day past the lead time, sessionStartMs is checked exactly below.
  const today = new Date(now).toISOString().slice(0, 10);
  const horizon = new Date(now + leadMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: reservations, error } = await db.from('reservations')
    .select('id, date, time_slot, session_type, therapist_name, clients(full_name, parent_id, guardian:profiles!parent_id(full_name, contact))')
    .in('status', ['confirmed', 'rescheduled'])
    .is('reminder_sent_at', null)
    .gte('date', today)
    .lte('date', horizon);
  if (error) { console.error('reminders: reservations query failed:', error.message); return; }

  for (const r of reservations || []) {
    const startMs = sessionStartMs(r.date, r.time_slot);
    if (startMs === null || startMs < now || startMs > now + leadMs) continue;
    await notifySessionReminderRow(r, settings);
    await db.from('reservations').update({ reminder_sent_at: new Date().toISOString() }).eq('id', r.id);
  }
}

/** Notifies (in-app only, this is an internal staff nudge, not guardian-facing) the
 *  assigned therapist that yesterday's session still has no Milestone (GAS) entry logged. */
async function notifyMilestoneReminderRow(r, settings) {
  const therapistId = await therapistUserId(r.therapist_name);
  if (!therapistId) return;
  const childName = r.clients?.full_name || 'this child';
  await notifyEvent('notify_milestone_reminder', {
    title: 'Milestone entry needed',
    body: `You need to input the milestone for ${childName}, you had a session on ${r.date}.`,
    icon: 'fa-trophy',
    target_user: therapistId
  });
}

/**
 * Once, the day after a session happens: if the therapist still hasn't logged
 * a Milestone (GAS) entry for it, remind them. `milestone_reminder_sent_at`
 * makes each reservation eligible exactly once, same pattern as
 * `reminder_sent_at` above, so re-running the sweep never re-sends it, and
 * there's deliberately no escalation or repeat beyond this single nudge.
 */
async function sendMilestoneReminders(settings) {
  if (settings.notify_milestone_reminder === false) return;
  if (settings.channel_in_app === false) return;
  const yesterday = new Date(Date.now() + 8 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: reservations, error } = await db.from('reservations')
    .select('id, date, therapist_name, client_id, clients(full_name)')
    .in('status', ['confirmed', 'completed', 'rescheduled'])
    .eq('date', yesterday)
    .is('milestone_reminder_sent_at', null);
  if (error) { console.error('reminders: milestone reservations query failed:', error.message); return; }
  if (!reservations?.length) return;

  // A GAS entry is linked to the exact reservation it's for (auto-matched at
  // submit time, see server/routes/gas.js), so "already logged" is just this lookup.
  const { data: linkedEntries } = await db.from('gas_entries')
    .select('reservation_id').in('reservation_id', reservations.map(r => r.id));
  const linked = new Set((linkedEntries || []).map(e => e.reservation_id));

  for (const r of reservations) {
    if (!linked.has(r.id) && r.therapist_name) await notifyMilestoneReminderRow(r, settings);
    // Marked as swept either way, logged, unassigned, or reminded, none of those
    // should make this same reservation get re-evaluated on every future sweep.
    await db.from('reservations').update({ milestone_reminder_sent_at: new Date().toISOString() }).eq('id', r.id);
  }
}

/**
 * Re-reminds guardians about an unpaid invoice every `balance_reminder_frequency_days`,
 * measured from the last reminder (or the invoice date, for the first one).
 */
async function sendBalanceReminders(settings) {
  if (settings.notify_balance_reminder === false) return;
  if (settings.channel_in_app === false && settings.channel_sms === false) return;
  const frequencyMs = (settings.balance_reminder_frequency_days || 3) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const { data: payments, error } = await db.from('payments')
    .select('id, amount, created_at, last_reminder_at, clients(full_name, parent_id, guardian:profiles!parent_id(full_name, contact))')
    .in('status', ['pending', 'overdue']);
  if (error) { console.error('reminders: payments query failed:', error.message); return; }

  for (const p of payments || []) {
    const lastSent = p.last_reminder_at ? Date.parse(p.last_reminder_at) : Date.parse(p.created_at);
    if (now - lastSent < frequencyMs) continue;
    await notifyBalanceReminderRow(p, settings);
    await db.from('payments').update({ last_reminder_at: new Date().toISOString() }).eq('id', p.id);
  }
}

/**
 * Manual "Notify" click (12.1 Reminders table) for one specific overdue/pending
 * invoice, always sends regardless of the automated reminder's own frequency
 * gate, since a staff member is explicitly asking for it right now.
 */
export async function notifyBalanceReminderNow(paymentId) {
  const { data: p, error } = await db.from('payments')
    .select('id, amount, clients(full_name, parent_id, guardian:profiles!parent_id(full_name, contact))')
    .eq('id', paymentId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!p) throw new Error('Payment not found');
  if (!p.clients?.parent_id) throw new Error('This client has no linked guardian account to notify.');
  const settings = { channel_in_app: await channelEnabled('channel_in_app'), channel_sms: await channelEnabled('channel_sms') };
  await notifyBalanceReminderRow(p, settings);
}

/** Manual "Notify" click (12.1 Reminders table) for one specific upcoming session. */
export async function notifySessionReminderNow(reservationId) {
  const { data: r, error } = await db.from('reservations')
    .select('id, date, time_slot, session_type, therapist_name, clients(full_name, parent_id, guardian:profiles!parent_id(full_name, contact))')
    .eq('id', reservationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!r) throw new Error('Reservation not found');
  if (!r.clients?.parent_id) throw new Error('This client has no linked guardian account to notify.');
  const settings = { channel_in_app: await channelEnabled('channel_in_app'), channel_sms: await channelEnabled('channel_sms') };
  await notifySessionReminderRow(r, settings);
}

/** Runs both reminder sweeps. Never throws, a bad sweep must not crash the server. */
export async function runReminderSweep() {
  try {
    const { data: settings } = await db.from('notification_settings').select('*').eq('id', 1).maybeSingle();
    if (!settings) return;
    await sendSessionReminders(settings);
    await sendBalanceReminders(settings);
    await sendMilestoneReminders(settings);
  } catch (e) {
    console.error('runReminderSweep failed:', e.message);
  }
}

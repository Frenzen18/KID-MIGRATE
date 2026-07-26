import { db } from '../supabase.js';
import { verifyWebhookSignature } from './paymongo.js';
import { logAudit } from './audit.js';
import { notifyEvent, therapistUserId } from './notify.js';

const PAID_EVENTS = new Set(['payment.paid', 'qr.paid']);

/**
 * POST /api/payments/webhook/paymongo, mounted with a raw body parser in
 * index.js (signature verification needs the exact bytes PayMongo signed,
 * so this must run before the global express.json() middleware).
 */
export async function handlePaymongoWebhook(req, res) {
  const rawBody = req.body?.toString('utf8') || '';
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
  const live = (process.env.PAYMONGO_SECRET_KEY || '').startsWith('sk_live_');

  const ok = verifyWebhookSignature(rawBody, req.headers['paymongo-signature'], secret, { live });
  if (!ok) {
    console.error('PayMongo webhook: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  // Always 200 once verified, PayMongo retries on non-2xx, and a shape we
  // don't recognize (or don't care about) isn't a delivery failure.
  res.status(200).json({ received: true });

  const type = event?.data?.attributes?.type;
  if (!PAID_EVENTS.has(type)) return;

  const paymentResource = event?.data?.attributes?.data;
  const intentId = paymentResource?.attributes?.payment_intent_id
    || paymentResource?.attributes?.data?.attributes?.payment_intent_id
    || null;
  if (!intentId) {
    console.error('PayMongo webhook: could not find payment_intent_id in payload');
    return;
  }

  await markPaidByIntentId(intentId);
}

/**
 * Shared by the webhook and the manual status-poll fallback. A combined
 * checkout (see POST /payments/checkout/combined) means several payment rows
 * can share the same intent id, so this always marks the WHOLE group paid
 * together, not just one row, singleton QRPh payments are just a group of one.
 */
export async function markPaidByIntentId(intentId) {
  const { data: group, error } = await db.from('payments').select('*').eq('pm_payment_intent_id', intentId);
  if (error || !group?.length) return null;
  if (group.every(p => p.status === 'paid')) return group[0]; // already handled, webhook + poll can race

  const { data: updatedRows, error: upErr } = await db.from('payments').update({
    status: 'paid',
    method: 'QRPh',
    reference: intentId,
    paid_at: new Date().toISOString()
  }).eq('pm_payment_intent_id', intentId).select();
  if (upErr) { console.error('Failed to mark payment(s) paid:', upErr.message); return null; }

  for (const updated of updatedRows) {
    await logAudit({
      table_name: 'payments', record_id: updated.id, action: 'approve',
      description: `QRPh payment confirmed (${updated.invoice_no || updated.id})`,
      approved_by: null // confirmed by PayMongo, not a portal user
    });
  }

  // One combined notification per client covered by this payment (almost
  // always just one), rather than a separate "payment received" per invoice.
  const clientIds = [...new Set(updatedRows.map(p => p.client_id))];
  for (const clientId of clientIds) {
    const { data: client } = await db.from('clients').select('parent_id').eq('id', clientId).maybeSingle();
    if (!client?.parent_id) continue;
    const rowsForClient = updatedRows.filter(p => p.client_id === clientId);
    const amt = rowsForClient.reduce((sum, p) => sum + Number(p.amount), 0);
    const body = rowsForClient.length > 1
      ? `We received your combined QRPh payment of ₱${amt.toLocaleString()}, covering ${rowsForClient.length} invoices.`
      : `We received your QRPh payment of ₱${amt.toLocaleString()} (${rowsForClient[0].invoice_no || rowsForClient[0].id}).`;
    await notifyEvent('notify_payment_received', { title: 'Payment received', body, icon: 'fa-peso-sign', target_user: client.parent_id });
  }

  // A guardian's own booking is held as 'awaiting_payment' until this exact
  // moment, payment succeeding is what actually gives them the slot. Checked
  // for every row in the group, a combined payment can cover more than one.
  for (const updated of updatedRows) {
    if (!updated.reservation_id) continue;
    const { data: reservation } = await db.from('reservations').select('*').eq('id', updated.reservation_id).maybeSingle();
    if (!reservation || reservation.status !== 'awaiting_payment') continue;

    await db.from('reservations').update({ status: 'confirmed', payment_expires_at: null }).eq('id', reservation.id);
    await logAudit({
      table_name: 'reservations', record_id: reservation.id, action: 'approve',
      description: `Booking confirmed on QRPh payment (${reservation.date} ${reservation.time_slot})`,
      approved_by: null
    });
    if (reservation.created_by) {
      await notifyEvent('notify_session_change', {
        title: 'Booking confirmed',
        body: `Payment received, your session on ${reservation.date} at ${reservation.time_slot} is confirmed.`,
        icon: 'fa-calendar-check',
        target_user: reservation.created_by
      });
    }
    // The assigned therapist only had a tentative hold to go on until now,
    // this is the first moment the session is real, they need to know too.
    const therapistId = await therapistUserId(reservation.therapist_name);
    if (therapistId) {
      const { data: resClient } = await db.from('clients').select('full_name').eq('id', reservation.client_id).maybeSingle();
      await notifyEvent('notify_session_change', {
        title: 'New session confirmed',
        body: `${resClient?.full_name || 'A client'}'s ${reservation.session_type} session on ${reservation.date} at ${reservation.time_slot} is now confirmed on your schedule.`,
        icon: 'fa-calendar-check',
        target_user: therapistId
      });
    }
  }

  return updatedRows[0];
}

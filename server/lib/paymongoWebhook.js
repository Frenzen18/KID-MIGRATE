import { db } from '../supabase.js';
import { verifyWebhookSignature } from './paymongo.js';
import { logAudit } from './audit.js';
import { notifyEvent } from './notify.js';

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

/** Shared by the webhook and the manual status-poll fallback. */
export async function markPaidByIntentId(intentId) {
  const { data: payment, error } = await db.from('payments').select('*').eq('pm_payment_intent_id', intentId).maybeSingle();
  if (error || !payment) return null;
  if (payment.status === 'paid') return payment; // already handled, webhook + poll can race

  const { data: updated, error: upErr } = await db.from('payments').update({
    status: 'paid',
    method: 'QRPh',
    reference: intentId,
    paid_at: new Date().toISOString()
  }).eq('id', payment.id).select().single();
  if (upErr) { console.error('Failed to mark payment paid:', upErr.message); return null; }

  await logAudit({
    table_name: 'payments', record_id: payment.id, action: 'approve',
    description: `QRPh payment confirmed (${payment.invoice_no || payment.id})`,
    approved_by: null // confirmed by PayMongo, not a portal user
  });

  const { data: client } = await db.from('clients').select('parent_id').eq('id', payment.client_id).maybeSingle();
  if (client?.parent_id) {
    await notifyEvent('notify_payment_received', {
      title: 'Payment received',
      body: `We received your QRPh payment of ₱${Number(updated.amount).toLocaleString()} (${updated.invoice_no || updated.id}).`,
      icon: 'fa-peso-sign',
      target_user: client.parent_id
    });
  }

  return updated;
}

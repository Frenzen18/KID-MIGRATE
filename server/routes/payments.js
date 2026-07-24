import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent, channelEnabled } from '../lib/notify.js';
import { genInvoiceNo } from '../lib/billing.js';
import { generateQrph, retrievePaymentIntent, retryQrphOnIntent } from '../lib/paymongo.js';
import { markPaidByIntentId } from '../lib/paymongoWebhook.js';
import { sendMail } from '../mailer.js';
import { makeLimiter, isProd, MIN } from '../lib/rateLimit.js';

const router = Router();
router.use(requireAuth);

// Each QR generation calls PayMongo's API (real cost/quota), cap it per IP so
// it can't be hammered into a runaway PayMongo bill or rate-limit trip.
const qrphLimiter = makeLimiter(isProd ? MIN : 10 * 1000, 10, 'Too many QR requests. Please wait a moment and try again.');
// The status endpoint is meant to be polled every few seconds while a checkout
// modal is open, so it needs a much more generous budget than one-shot QR generation.
const qrphStatusLimiter = makeLimiter(isProd ? MIN : 10 * 1000, 60, 'Too many status checks. Please wait a moment and try again.');

/** GET /api/payments, staff/admin all; parents see their children's */
router.get('/', async (req, res) => {
  let q = db.from('payments').select('*, clients(full_name, client_code, parent_id, guardian_name, therapy_type), reservations(session_type, date, time_slot, duration_min, therapist_name)').order('created_at', { ascending: false });
  if (req.query.status) q = q.eq('status', req.query.status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const rows = req.user.role === 'parent'
    ? (data || []).filter(p => p.clients?.parent_id === req.user.id)
    : data;
  res.json(rows);
});

/** POST /api/payments, record a payment (admin/staff) */
router.post('/', requireRole('admin', 'staff'), async (req, res) => {
  const b = req.body || {};
  if (!b.client_id || !b.amount) return res.status(400).json({ error: 'client_id and amount are required' });
  if (!Number.isFinite(Number(b.amount)) || Number(b.amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  const invoice_no = await genInvoiceNo();
  const { data, error } = await db.from('payments').insert({
    client_id: b.client_id, amount: b.amount, method: b.method || 'Cash',
    reference: b.reference || null, status: b.status || 'paid',
    invoice_no, sealed: false,
    paid_at: (b.status || 'paid') === 'paid' ? new Date().toISOString() : null
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'payments', record_id: data.id, action: 'create',
    description: `Recorded ${data.method} payment of ₱${data.amount} (${data.invoice_no})`,
    created_by: req.user.id
  });
  if (data.status === 'paid') {
    await logAudit({
      table_name: 'payments', record_id: data.id, action: 'approve',
      description: `Payment verified at recording (${data.invoice_no})`,
      approved_by: req.user.id
    });
    const { data: client } = await db.from('clients').select('parent_id').eq('id', data.client_id).maybeSingle();
    if (client?.parent_id) {
      await notifyEvent('notify_payment_received', {
        title: 'Payment received',
        body: `We received your ${data.method} payment of ₱${Number(data.amount).toLocaleString()} (${data.invoice_no}).`,
        icon: 'fa-peso-sign',
        target_user: client.parent_id
      });
    }
  }

  res.status(201).json(data);
});

/** PUT /api/payments/:id, update status / seal / amount */
router.put('/:id', requireRole('admin', 'staff'), async (req, res) => {
  const patch = {};
  for (const k of ['status','method','reference','sealed','amount']) if (k in req.body) patch[k] = req.body[k];
  if ('amount' in patch) {
    const amt = Number(patch.amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    patch.amount = amt;
  }
  if (req.body.status === 'paid') patch.paid_at = new Date().toISOString();
  const { data, error } = await db.from('payments').update(patch).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (patch.status === 'paid') {
    await logAudit({
      table_name: 'payments', record_id: req.params.id, action: 'approve',
      description: `Payment marked as paid (${data.invoice_no})`,
      approved_by: req.user.id
    });
    const { data: client } = await db.from('clients').select('parent_id').eq('id', data.client_id).maybeSingle();
    if (client?.parent_id) {
      await notifyEvent('notify_payment_received', {
        title: 'Payment received',
        body: `We received your ${data.method} payment of ₱${Number(data.amount).toLocaleString()} (${data.invoice_no}).`,
        icon: 'fa-peso-sign',
        target_user: client.parent_id
      });
    }
  } else {
    await logAudit({
      table_name: 'payments', record_id: req.params.id, action: 'update',
      description: `Payment updated (${data.invoice_no})` + (patch.sealed ? ', sealed' : '') + (patch.status ? `, status set to ${patch.status}` : '') + ('amount' in patch ? `, amount set to ₱${patch.amount}` : ''),
      updated_by: req.user.id
    });
  }

  res.json(data);
});

/**
 * POST /api/payments/:id/refund { reason }, admin/staff only.
 * A refund isn't just a status flip: it also frees up the session (cancels
 * the linked reservation so the parent isn't stuck unable to rebook that
 * child), and tells the parent what happened and why, in-app and by email.
 */
router.post('/:id/refund', requireRole('admin', 'staff'), async (req, res) => {
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A refund reason is required' });

  const { data: payment, error } = await db.from('payments')
    .select('*, clients(full_name, parent_id)')
    .eq('id', req.params.id).single();
  if (error || !payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.status !== 'paid') {
    const msg = payment.status === 'refunded'
      ? 'This invoice was already refunded.'
      : `Only paid invoices can be refunded (this one is currently "${payment.status}").`;
    return res.status(400).json({ error: msg });
  }

  const { data: updated, error: upErr } = await db.from('payments')
    .update({ status: 'refunded', refund_reason: reason })
    .eq('id', payment.id).select().single();
  if (upErr) return res.status(500).json({ error: upErr.message });

  // Free up the session, otherwise the parent's "one active booking per
  // child" guard keeps blocking them on a reservation that was never cancelled.
  let cancelledReservation = null;
  if (payment.reservation_id) {
    const { data: resv } = await db.from('reservations').select('*').eq('id', payment.reservation_id).maybeSingle();
    if (resv && !['cancelled', 'declined'].includes(resv.status)) {
      const { data: cancelled } = await db.from('reservations').update({
        status: 'cancelled',
        notes: (resv.notes ? resv.notes + ' · ' : '') + `Cancelled, payment refunded: ${reason}`
      }).eq('id', resv.id).select().single();
      cancelledReservation = cancelled;
      await logAudit({
        table_name: 'reservations', record_id: resv.id, action: 'update',
        description: `Reservation cancelled due to refund of ${payment.invoice_no || payment.id}`,
        updated_by: req.user.id
      });
    }
  }

  // Tell the parent, refunds used to vanish from their view entirely.
  const parentId = payment.clients?.parent_id;
  if (parentId) {
    const sessionNote = cancelledReservation ? ` Your session on ${cancelledReservation.date} at ${cancelledReservation.time_slot} has been cancelled, you're free to book a new slot.` : '';
    await db.from('notifications').insert({
      title: 'Payment refunded',
      body: `Your payment of ₱${Number(payment.amount).toLocaleString()} (${payment.invoice_no || payment.id}) was refunded. Reason: ${reason}.${sessionNote}`,
      icon: 'fa-rotate-left',
      target_user: parentId
    });

    const { data: parent } = await db.from('profiles').select('email, full_name').eq('id', parentId).maybeSingle();
    if (parent?.email && await channelEnabled('channel_email')) {
      sendMail({
        to: parent.email,
        subject: 'Payment refunded: KID Clinic',
        html: `
          <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
              <p style="color: #64748B; font-size: 13px;">Pediatric Speech & Occupational Therapy</p>
            </div>
            <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px;">
              <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${parent.full_name || 'there'},</p>
              <p style="color: #64748B; font-size: 13px; margin: 0 0 16px; line-height: 1.7;">
                Your payment of <strong>₱${Number(payment.amount).toLocaleString()}</strong> (${payment.invoice_no || payment.id}) has been refunded.
              </p>
              <p style="color: #64748B; font-size: 13px; margin: 0 0 16px; line-height: 1.7;"><strong>Reason:</strong> ${reason}</p>
              ${cancelledReservation ? `<p style="color: #64748B; font-size: 13px; margin: 0; line-height: 1.7;">Your session on <strong>${cancelledReservation.date} at ${cancelledReservation.time_slot}</strong> has been cancelled. You're welcome to book a new slot from your parent portal.</p>` : ''}
            </div>
          </div>
        `
      }).catch(e => console.error('Refund email error:', e.message));
    }
  }

  await logAudit({
    table_name: 'payments', record_id: payment.id, action: 'update',
    description: `Refunded ₱${payment.amount} (${payment.invoice_no || payment.id}), ${reason}`,
    updated_by: req.user.id
  });

  res.json(updated);
});

/** POST /api/payments/:id/qrph, generate (or reuse) a PayMongo QRPh code for this invoice */
router.post('/:id/qrph', qrphLimiter, async (req, res) => {
  const { data: payment, error } = await db.from('payments').select('*, clients(full_name, parent_id)').eq('id', req.params.id).single();
  if (error || !payment) return res.status(404).json({ error: 'Payment not found' });
  // Billing is admin/staff-only, or the parent paying their own child's invoice.
  // Not a therapist role (ot/speech), which has no business generating a live
  // PayMongo payment QR for any client's invoice.
  const canAccess = req.user.role === 'admin' || req.user.role === 'staff'
    || (req.user.role === 'parent' && payment.clients?.parent_id === req.user.id);
  if (!canAccess) return res.status(403).json({ error: 'Not your invoice' });
  if (payment.status === 'paid') return res.status(400).json({ error: 'This invoice is already paid' });

  // Reuse an existing unexpired QR, but only if it's still actually payable,
  // an unexpired-but-failed source (e.g. a simulated failed test payment)
  // would otherwise keep getting handed back forever, unpayable.
  let staleIntentId = null;
  if (payment.pm_payment_intent_id && payment.qr_image_url && payment.qr_expires_at && new Date(payment.qr_expires_at) > new Date()) {
    try {
      const intent = await retrievePaymentIntent(payment.pm_payment_intent_id);
      if (intent.attributes?.status !== 'awaiting_payment_method') {
        return res.json({
          qr_image_url: payment.qr_image_url, expires_at: payment.qr_expires_at,
          payment_intent_id: payment.pm_payment_intent_id, test_url: payment.qr_test_url
        });
      }
      // Status flipped back to awaiting_payment_method, the previous source
      // failed, retry on this same intent instead of starting a whole new one.
      staleIntentId = payment.pm_payment_intent_id;
    } catch {
      // Lookup itself failed, fall through and just generate a brand new one.
    }
  }

  try {
    const qr = staleIntentId
      ? await retryQrphOnIntent(staleIntentId, payment.pm_client_key)
      : await generateQrph({
        amount: payment.amount,
        description: `KID Clinic invoice ${payment.invoice_no || payment.id}`,
        metadata: { payment_id: payment.id, invoice_no: payment.invoice_no || '' }
      });
    const { error: upErr } = await db.from('payments').update({
      pm_payment_intent_id: qr.intentId,
      pm_client_key: qr.clientKey,
      qr_image_url: qr.qrImageUrl,
      qr_expires_at: qr.expiresAt,
      qr_test_url: qr.testUrl
    }).eq('id', payment.id);
    if (upErr) {
      // qr_test_url may not exist yet if migration_qr_test_url.sql hasn't been run,       // retry without it so QR generation itself never breaks; the test link just
      // won't survive a reopen of this modal until the column is added.
      const { error: retryErr } = await db.from('payments').update({
        pm_payment_intent_id: qr.intentId, pm_client_key: qr.clientKey,
        qr_image_url: qr.qrImageUrl, qr_expires_at: qr.expiresAt
      }).eq('id', payment.id);
      if (retryErr) return res.status(500).json({ error: retryErr.message });
    }

    res.json({ qr_image_url: qr.qrImageUrl, expires_at: qr.expiresAt, payment_intent_id: qr.intentId, test_url: qr.testUrl });
  } catch (e) {
    res.status(502).json({ error: 'PayMongo error: ' + e.message });
  }
});

/** GET /api/payments/:id/qrph/status, polling fallback for environments without a public webhook URL yet */
router.get('/:id/qrph/status', qrphStatusLimiter, async (req, res) => {
  const { data: payment, error } = await db.from('payments').select('*, clients(parent_id)').eq('id', req.params.id).single();
  if (error || !payment) return res.status(404).json({ error: 'Payment not found' });
  const canAccess = req.user.role === 'admin' || req.user.role === 'staff'
    || (req.user.role === 'parent' && payment.clients?.parent_id === req.user.id);
  if (!canAccess) return res.status(403).json({ error: 'Not your invoice' });
  if (payment.status === 'paid') return res.json({ status: 'paid' });
  if (!payment.pm_payment_intent_id) return res.json({ status: 'no_qr' });

  try {
    const intent = await retrievePaymentIntent(payment.pm_payment_intent_id);
    const pmStatus = intent.attributes.status;
    if (pmStatus === 'succeeded') {
      await markPaidByIntentId(payment.pm_payment_intent_id);
      return res.json({ status: 'paid' });
    }
    res.json({ status: pmStatus });
  } catch (e) {
    res.status(502).json({ error: 'PayMongo error: ' + e.message });
  }
});

export default router;

import crypto from 'crypto';

const API_BASE = 'https://api.paymongo.com/v1';

function authHeader() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) throw new Error('PAYMONGO_SECRET_KEY is not configured');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

async function pm(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.errors?.[0]?.detail || res.statusText || 'PayMongo request failed';
    throw new Error(msg);
  }
  return json.data;
}

/** Step 1, a Payment Intent for the invoice total (amount in whole PHP; PayMongo wants centavos). */
export async function createPaymentIntent({ amount, description, metadata }) {
  return pm('/payment_intents', {
    data: {
      attributes: {
        amount: Math.round(Number(amount) * 100),
        currency: 'PHP',
        payment_method_allowed: ['qrph'],
        description,
        metadata
      }
    }
  });
}

/** Step 2, a QRPh payment method to attach. */
export async function createQrphPaymentMethod() {
  return pm('/payment_methods', { data: { attributes: { type: 'qrph' } } });
}

/** Step 3, attach it; the response carries the scannable QR under attributes.next_action.code.image_url. */
export async function attachPaymentMethod(intentId, paymentMethodId, clientKey) {
  return pm(`/payment_intents/${intentId}/attach`, {
    data: { attributes: { payment_method: paymentMethodId, client_key: clientKey } }
  });
}

/** Full QRPh generation flow for one invoice, returns { intentId, clientKey, qrImageUrl, status, expiresAt }. */
export async function generateQrph({ amount, description, metadata }) {
  const intent = await createPaymentIntent({ amount, description, metadata });
  const method = await createQrphPaymentMethod();
  const attached = await attachPaymentMethod(intent.id, method.id, intent.attributes.client_key);
  // next_action.code.expires_at is already an ISO 8601 string.
  const code = attached.attributes?.next_action?.code;

  return {
    intentId: intent.id,
    clientKey: intent.attributes.client_key,
    qrImageUrl: code?.image_url || null,
    // Sandbox-only: PayMongo test-mode QR codes must NOT be scanned (it processes
    // a real-looking transaction), this URL simulates payment instead. null in live mode.
    testUrl: attached.attributes.livemode ? null : (code?.test_url || null),
    status: attached.attributes.status,
    expiresAt: code?.expires_at || new Date(Date.now() + 1800 * 1000).toISOString()
  };
}

/**
 * Retry path for an intent whose attached source already failed/expired (a
 * simulated "failed" test payment, or a scanned-but-abandoned real one).
 * PayMongo can't re-succeed a dead source, once it fails the intent itself
 * reverts to 'awaiting_payment_method', so this attaches a brand new one to
 * get a fresh, still-payable QR without losing the original invoice/intent.
 */
export async function retryQrphOnIntent(intentId, clientKey) {
  const method = await createQrphPaymentMethod();
  const attached = await attachPaymentMethod(intentId, method.id, clientKey);
  const code = attached.attributes?.next_action?.code;
  return {
    intentId,
    clientKey,
    qrImageUrl: code?.image_url || null,
    testUrl: attached.attributes.livemode ? null : (code?.test_url || null),
    status: attached.attributes.status,
    expiresAt: code?.expires_at || new Date(Date.now() + 1800 * 1000).toISOString()
  };
}

/** Polling fallback for local/dev where PayMongo can't reach a public webhook URL yet. */
export async function retrievePaymentIntent(intentId) {
  const res = await fetch(`${API_BASE}/payment_intents/${intentId}`, {
    headers: { Authorization: authHeader() }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.errors?.[0]?.detail || 'PayMongo request failed');
  return json.data;
}

/**
 * Verifies the `Paymongo-Signature` header: `t=<ts>,te=<test sig>,li=<live sig>`,
 * HMAC-SHA256 of `${t}.${rawBody}` using the webhook endpoint's own signing
 * secret (from the PayMongo Dashboard → Developers → Webhooks, NOT the API key).
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret, { live = false } = {}) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map(kv => { const [k, v] = kv.split('='); return [k, v]; })
  );
  const timestamp = parts.t;
  const expected = live ? parts.li : parts.te;
  if (!timestamp || !expected) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

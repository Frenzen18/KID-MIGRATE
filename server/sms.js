import { normalizePhone } from './phone.js';

/**
 * SMS Mobile API (smsmobileapi.com), relays through a phone with their app
 * installed and connected to the account, not a telecom-integrated gateway.
 * Deliverability depends on that phone staying online. See https://smsmobileapi.com/doc/
 */
const SEND_URL = 'https://api.smsmobileapi.com/sendsms/';

/** Sends one SMS. Throws on missing config, invalid number, or an API-reported failure. */
export async function sendSms({ to, message }) {
  const apiKey = process.env.SMSMOBILEAPI_KEY;
  if (!apiKey) throw new Error('SMSMOBILEAPI_KEY is not configured.');

  const phone = normalizePhone(to);
  if (!phone) throw new Error('Invalid recipient phone number.');

  const url = new URL(SEND_URL);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('recipients', phone);
  url.searchParams.set('message', message);

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => null);
  const result = data?.result;
  if (!res.ok || !result || Number(result.error) !== 0) {
    throw new Error('SMS Mobile API error: ' + (result?.message || result?.error || res.status));
  }
  return result;
}

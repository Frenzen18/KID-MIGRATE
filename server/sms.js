import { normalizePhone } from './phone.js';

/**
 * PhilSMS (philsms.com), a telecom-integrated SMS gateway for the Philippines.
 * See the Developers page in the PhilSMS dashboard for docs/token, note the
 * account-specific API host is dashboard.philsms.com, not app.philsms.com
 * (the domain used in PhilSMS's own public docs, which 401s). Replaced SMS
 * Mobile API (smsmobileapi.com) after its subscription lapsed, that relayed
 * through a phone with their app installed rather than a real telecom gateway.
 */
const SEND_URL = 'https://dashboard.philsms.com/api/v3/sms/send';

/** Sends one SMS. Throws on missing config, invalid number, or an API-reported failure. */
export async function sendSms({ to, message }) {
  const apiToken = process.env.PHILSMS_API_TOKEN;
  if (!apiToken) throw new Error('PHILSMS_API_TOKEN is not configured.');
  const senderId = process.env.PHILSMS_SENDER_ID || 'PhilSMS';

  const phone = normalizePhone(to);
  if (!phone) throw new Error('Invalid recipient phone number.');

  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiToken,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    // PhilSMS wants the recipient as digits-only with country code, no leading "+".
    body: JSON.stringify({ recipient: phone.replace('+', ''), sender_id: senderId, type: 'plain', message })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.status !== 'success') {
    throw new Error('PhilSMS error: ' + (data?.message || res.status));
  }
  return data;
}

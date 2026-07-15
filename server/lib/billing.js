/**
 * Standard session rates (PHP). No pricing table exists yet in the schema,  * these mirror the figures already used across the app's mock billing UI
 * (OT ₱1,400 / Speech ₱1,200 / combined ₱2,800). Adjust here if rates change.
 */
const SESSION_RATES = { OT: 1400, Speech: 1200, Both: 2800, Default: 1400 };

const isOT = t => /occupational|\bOT\b/i.test(t || '');
const isSpeech = t => /speech/i.test(t || '');

/** Picks a session's rate from its `session_type` text. */
export function rateFor(sessionType) {
  const ot = isOT(sessionType);
  const sp = isSpeech(sessionType);
  if (ot && sp) return SESSION_RATES.Both;
  if (sp) return SESSION_RATES.Speech;
  if (ot) return SESSION_RATES.OT;
  return SESSION_RATES.Default;
}

/** INV-YYYYMMDD-### */
export function genInvoiceNo() {
  return 'INV-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + String(Math.floor(Math.random() * 900) + 100);
}

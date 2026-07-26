import { db } from '../supabase.js';

/**
 * Standard session rates (PHP). No pricing table exists yet in the schema,  * these mirror the figures already used across the app's mock billing UI
 * (OT ₱1,400 / Speech ₱1,200 / combined ₱2,800). Adjust here if rates change.
 */
const SESSION_RATES = { OT: 1400, Speech: 1200, Both: 2800, Default: 1400 };

/** Flat no-show penalty (PHP), per the clinic's MOA no-show policy, a separate
 *  charge from the session fee itself. Staff can still waive or edit the
 *  amount on the payment record like any other invoice. */
export const NO_SHOW_FEE = 500;

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

/** MOA slot-retainment fee: 50% of the regular session rate, charged once
 *  when 3 consecutive excused absences threaten a recurring slot. */
export function retainerFeeFor(sessionType) {
  return Math.round(rateFor(sessionType) * 0.5);
}

/**
 * INV-YYYYMMDD-##### — the numeric part is a global Postgres sequence
 * (invoice_no_seq, see supabase/migration_invoice_sequence.sql), so invoice
 * numbers always count up strictly instead of a random per-invoice suffix.
 */
export async function genInvoiceNo() {
  const { data, error } = await db.rpc('next_invoice_no');
  if (error) throw new Error('Failed to generate invoice number: ' + error.message);
  return data;
}

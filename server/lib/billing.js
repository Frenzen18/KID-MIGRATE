import { db } from '../supabase.js';

/** Flat no-show penalty (PHP), per the clinic's MOA no-show policy, a separate
 *  charge from the session fee itself. Staff can still waive or edit the
 *  amount on the payment record like any other invoice. */
export const NO_SHOW_FEE = 500;

const isSpeech = t => /speech/i.test(t || '');

/** Admin/staff-editable session rates (PHP), stored on branding_settings
 *  (id=1) alongside clinic hours, see PUT /api/settings/prices and the
 *  "Session Prices" panel on the admin Employee Scheduling tab. Reading from
 *  the DB (instead of a hardcoded constant) means a promo price change takes
 *  effect on the next booking immediately, no deploy needed. */
async function currentPrices() {
  const { data, error } = await db.from('branding_settings')
    .select('price_ot, price_speech, price_initial_assessment').eq('id', 1).single();
  if (error) throw new Error('Failed to load session prices: ' + error.message);
  return data;
}

/** Picks a session's rate from its `session_type` text. A reservation's
 *  session_type is always a single discipline ("Occupational Therapy" or
 *  "Speech Therapy"), even for a Combined-therapy client, their two
 *  disciplines are booked (and billed) as separate sessions, never one
 *  dual-discipline session_type, so there's no "combined" rate to pick here. */
export async function rateFor(sessionType) {
  const prices = await currentPrices();
  if (sessionType === 'Initial Assessment') return prices.price_initial_assessment;
  if (isSpeech(sessionType)) return prices.price_speech;
  return prices.price_ot; // OT, or any other/unrecognized session type
}

/** MOA slot-retainment fee: 50% of the regular session rate, charged once
 *  when 3 consecutive excused absences threaten a recurring slot. */
export async function retainerFeeFor(sessionType) {
  return Math.round((await rateFor(sessionType)) * 0.5);
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

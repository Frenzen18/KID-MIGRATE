// Manual verification script (no automated test runner in this repo).
// Run: node server/scripts/verify-cancellation-review.js
// Prints the before/after payments state for one excused and one unexcused
// review, against real test data you supply (edit the ids below).
import { db } from '../supabase.js';
import { applyCancellationReviewSideEffects } from '../lib/noShow.js';

const RESERVATION_ID = process.argv[2];
const VERDICT = process.argv[3]; // 'excused' or 'unexcused'

if (!RESERVATION_ID || !['excused', 'unexcused'].includes(VERDICT)) {
  console.error('Usage: node server/scripts/verify-cancellation-review.js <reservation_id> <excused|unexcused>');
  process.exit(1);
}

const { data: reservation } = await db.from('reservations').select('*').eq('id', RESERVATION_ID).single();
console.log('Before:', reservation);
const { data: paymentsBefore } = await db.from('payments').select('*').eq('reservation_id', RESERVATION_ID);
console.log('Payments before:', paymentsBefore);

await applyCancellationReviewSideEffects(reservation, VERDICT === 'excused', null);

const { data: paymentsAfter } = await db.from('payments').select('*').or(`reservation_id.eq.${RESERVATION_ID},reservation_id.is.null`).order('created_at', { ascending: false }).limit(5);
console.log('Payments after (incl. any new floating credit):', paymentsAfter);
process.exit(0);

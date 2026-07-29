/** How far ahead the recurring-schedule auto-fill keeps confirmed
 *  reservations generated (see server/lib/recurringFill.js), and also the
 *  advance-payment cap (see server/routes/payments.js): a session can't be
 *  paid for before it's been generated, so there's nothing further to guard
 *  there beyond this one horizon. Lives in its own file (not recurringFill.js)
 *  so server/routes/payments.js can import just this constant without
 *  transitively loading the entire reservations.js route module (multer
 *  setup, bucket-creation IIFE, etc.) that recurringFill.js itself imports
 *  from. */
export const FILL_HORIZON_DAYS = 14;

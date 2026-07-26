-- A combined checkout (POST /payments/checkout/combined) deliberately puts the
-- SAME PayMongo payment_intent_id on several invoices at once, one QR paying
-- all of them together; markPaidByIntentId marks every row sharing that
-- intent id paid as a group. The old unique index only ever expected one
-- payment row per intent id (single-invoice QRPh), so it must be relaxed to a
-- plain (non-unique) index before combined checkout can store more than one
-- row per intent.
drop index if exists payments_pm_intent_uidx;
create index if not exists payments_pm_intent_idx on payments (pm_payment_intent_id) where pm_payment_intent_id is not null;

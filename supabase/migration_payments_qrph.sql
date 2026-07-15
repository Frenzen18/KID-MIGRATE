-- Migration: link payments to bookings + PayMongo QRPh fields
-- Run this in Supabase Dashboard → SQL Editor
--
-- 1) A confirmed reservation now auto-creates a 'pending' payment/invoice
--    (see server/routes/reservations.js ensurePaymentForReservation). This
--    column lets a payment point back at the session it's for.
alter table payments add column if not exists reservation_id uuid references reservations (id) on delete set null;
create index if not exists payments_reservation_idx on payments (reservation_id);

-- 2) PayMongo QRPh state — set once a QR code has been generated for this
--    invoice, and read back by the webhook / status-poll to confirm payment.
alter table payments add column if not exists pm_payment_intent_id text;
alter table payments add column if not exists pm_client_key text;
alter table payments add column if not exists qr_image_url text;
alter table payments add column if not exists qr_expires_at timestamptz;
create unique index if not exists payments_pm_intent_uidx on payments (pm_payment_intent_id) where pm_payment_intent_id is not null;

-- Migration: persist the PayMongo sandbox "Simulate Payment" link alongside
-- the cached QR code, so re-opening a QRPh invoice's payment modal doesn't
-- lose the demo/test-mode button once the QR is being reused instead of
-- freshly generated (server/routes/payments.js POST /:id/qrph).
-- Run this in Supabase Dashboard → SQL Editor
alter table payments add column if not exists qr_test_url text;

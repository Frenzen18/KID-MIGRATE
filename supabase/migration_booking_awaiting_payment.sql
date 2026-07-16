-- Migration: guardian self-bookings now go straight to payment instead of a
-- staff-approved "pending" request. A fresh guardian booking is created as
-- 'awaiting_payment' (holds the slot, counts against capacity) and only
-- becomes 'confirmed' once the PayMongo QRPh payment actually succeeds.
-- `payment_expires_at` bounds how long an unpaid hold can occupy a slot,
-- server/lib/bookingHolds.js sweeps and releases ones that expire unpaid.
--
-- Run this in Supabase Dashboard → SQL Editor.

alter table reservations add column if not exists payment_expires_at timestamptz;

alter table reservations drop constraint if exists reservations_status_check;
alter table reservations add constraint reservations_status_check
  check (status in ('awaiting_payment','pending','confirmed','rescheduled','cancelled','completed','declined','no_show'));

drop index if exists reservations_active_slot_therapist_uidx;
create unique index reservations_active_slot_therapist_uidx on reservations (date, time_slot, therapist_name)
  where status not in ('cancelled', 'declined', 'no_show');

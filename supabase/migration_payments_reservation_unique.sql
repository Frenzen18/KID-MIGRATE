-- Migration: prevent duplicate auto-generated invoices for the same reservation.
-- ensurePaymentForReservation() (server/routes/reservations.js) does a
-- check-then-insert that has a race window under concurrent requests or a
-- double-clicked "Confirm" button, the database is the real guard, same
-- pattern as reservations_active_slot_therapist_uidx for double-booking.
--
-- Run this in Supabase Dashboard → SQL Editor.

create unique index if not exists payments_reservation_uidx
  on payments (reservation_id) where reservation_id is not null;

-- Migration: close a real double-booking race for Initial Assessment slots.
--
-- reservations_active_slot_therapist_uidx (date, time_slot, therapist_name)
-- already prevents two active bookings for the same therapist at the same
-- time, but Initial Assessment rows always have therapist_name = NULL (no
-- therapist is picked yet, see slotInfoForDate's Initial Assessment branch),
-- and Postgres treats NULL as distinct from NULL in a unique index, so that
-- index lets unlimited concurrent Initial Assessment rows through at the same
-- date+time_slot. The route's own "only one Initial Assessment per hour"
-- check is a plain SELECT-then-INSERT with a real race window: two parents
-- submitting within milliseconds of each other can both pass the SELECT
-- before either INSERT lands, first-come-first-served requires the database
-- to be the actual tiebreaker, same reasoning as reservations_active_slot_therapist_uidx.
--
-- Run this in Supabase Dashboard → SQL Editor.

create unique index if not exists reservations_active_ia_slot_uidx
  on reservations (date, time_slot)
  where session_type = 'Initial Assessment' and status not in ('cancelled', 'declined', 'no_show');

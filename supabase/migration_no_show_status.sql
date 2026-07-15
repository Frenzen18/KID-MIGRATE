-- Migration: add a "no_show" reservation status.
-- Lets staff record that a client didn't show up for a confirmed/rescheduled
-- session — distinct from "cancelled" (called off before the session) or
-- "declined" (never approved). A no-show also shouldn't be treated as an
-- active/occupied slot going forward, so it's added to the same exclusion
-- list as cancelled/declined in the double-booking guard.
--
-- Run this in Supabase Dashboard → SQL Editor.

alter table reservations drop constraint if exists reservations_status_check;
alter table reservations add constraint reservations_status_check
  check (status in ('pending','confirmed','rescheduled','cancelled','completed','declined','no_show'));

drop index if exists reservations_active_slot_therapist_uidx;
create unique index reservations_active_slot_therapist_uidx on reservations (date, time_slot, therapist_name)
  where status not in ('cancelled', 'declined', 'no_show');

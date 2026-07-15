-- Removes the per-shift Room field — therapist shift schedules no longer
-- track a room assignment. (reservations.room is a separate, unrelated
-- booking-level field and is NOT affected by this migration.)
-- Run in: Supabase Dashboard → SQL Editor.
-- Safe to re-run — IF EXISTS guards the column drop.

alter table shifts
  drop column if exists room;

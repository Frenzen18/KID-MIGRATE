-- Migration: add Sunday to the therapist availability matrix (3.2.2). shifts.work_days
-- was a 6-element Mon-Sat array; the app now expects 7 (Mon..Sun), Sunday defaulting
-- to closed. Backfill existing rows so their saved Mon-Sat pattern is preserved instead
-- of being silently reset to "all days on" by the app's length-mismatch fallback.
-- Run this in Supabase Dashboard → SQL Editor. Safe to re-run (guarded by the length check).

update shifts set work_days = work_days || array[false] where array_length(work_days, 1) = 6;

alter table shifts alter column work_days set default '{true,true,true,true,true,true,false}';

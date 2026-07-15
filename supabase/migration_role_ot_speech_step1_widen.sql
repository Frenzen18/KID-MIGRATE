-- Migration step 1 of 2: split 'therapist' into 'ot' and 'speech'.
--
-- This step only WIDENS the role constraint to accept the new values
-- alongside the old one — it does not remove 'therapist' yet. That must
-- wait until every existing 'therapist' row has been reassigned, otherwise
-- this ALTER would fail immediately (Postgres validates existing rows
-- against a new constraint).
--
-- Run this FIRST in Supabase Dashboard → SQL Editor, THEN run
-- `node scripts/migrate-therapist-roles.mjs`, THEN run
-- migration_role_ot_speech_step2_tighten.sql.

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin','staff','therapist','ot','speech','parent'));

-- Migration step 2 of 2: split 'therapist' into 'ot' and 'speech'.
--
-- Run this AFTER migration_role_ot_speech_step1_widen.sql and AFTER
-- `node scripts/migrate-therapist-roles.mjs` has reassigned every existing
-- 'therapist' profile to 'ot' or 'speech' — this step removes 'therapist'
-- from the allowed values and drops the now-redundant specialty column
-- (role directly encodes discipline now).
--
-- Run this in Supabase Dashboard → SQL Editor.

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin','staff','ot','speech','parent'));

alter table profiles drop column if exists specialty;

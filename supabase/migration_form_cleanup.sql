-- Migration: intake-form cleanup (panel feedback items 14, 15, 16)
-- Run this in Supabase Dashboard → SQL Editor BEFORE using the updated intake form.

-- 15. Relationship of the registering adult to the child
ALTER TABLE clients ADD COLUMN IF NOT EXISTS guardian_relationship text
  CHECK (guardian_relationship IN ('Parent', 'Guardian', 'Caretaker'));

-- 14. Occupation is no longer collected (data minimization / RA 10173)
ALTER TABLE clients DROP COLUMN IF EXISTS guardian_occupation;

-- 16. Living-arrangement question removed (data minimization / RA 10173)
ALTER TABLE clients DROP COLUMN IF EXISTS child_lives_with;

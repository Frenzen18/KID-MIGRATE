-- Migration: therapy type is assigned by the clinic after assessment,
-- not chosen by the parent at registration — so it must allow NULL
-- (meaning "for assessment") on newly registered children.
-- Run this in Supabase Dashboard → SQL Editor.

ALTER TABLE clients ALTER COLUMN therapy_type DROP NOT NULL;
ALTER TABLE clients ALTER COLUMN therapy_type DROP DEFAULT;

-- Home address is no longer collected from parents (data minimization).
ALTER TABLE clients DROP COLUMN IF EXISTS guardian_address;

-- diagnosis and medical_conditions columns stay: the clinic fills them in
-- after assessment (they are no longer collected from parents).

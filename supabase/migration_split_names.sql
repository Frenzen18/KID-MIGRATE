-- Migration: split full_name into first_name + last_name, and store the
-- contact number on profiles (needed for the duplicate-number check).
-- Run this in Supabase Dashboard → SQL Editor.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contact text;

-- Best-effort backfill from full_name: first word → first_name, rest → last_name.
-- Review the result for names this splits wrong (e.g. two-word first names).
UPDATE profiles SET
  first_name = COALESCE(first_name,
    CASE WHEN position(' ' in full_name) > 0
         THEN split_part(full_name, ' ', 1)
         ELSE full_name END),
  last_name = COALESCE(last_name,
    CASE WHEN position(' ' in full_name) > 0
         THEN substr(full_name, position(' ' in full_name) + 1)
         ELSE '' END)
WHERE full_name IS NOT NULL;

-- full_name stays as the display value (kept in sync by the server:
-- always written as first_name || ' ' || last_name).

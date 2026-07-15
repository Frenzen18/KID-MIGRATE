-- Migration: split the child's full_name into first_name + last_name on clients.
-- Run this in Supabase Dashboard → SQL Editor.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_name text;

-- Best-effort backfill: first word → first_name, rest → last_name.
UPDATE clients SET
  first_name = COALESCE(first_name,
    CASE WHEN position(' ' in full_name) > 0
         THEN split_part(full_name, ' ', 1)
         ELSE full_name END),
  last_name = COALESCE(last_name,
    CASE WHEN position(' ' in full_name) > 0
         THEN substr(full_name, position(' ' in full_name) + 1)
         ELSE '' END)
WHERE full_name IS NOT NULL;

-- full_name stays as the display value (server writes it as first || ' ' || last).

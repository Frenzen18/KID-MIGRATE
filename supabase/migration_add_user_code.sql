-- Migration: Add user_code column to profiles table
-- Run this in Supabase Dashboard → SQL Editor

-- 1. Add the column
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS user_code text UNIQUE;

-- 2. Backfill existing rows with KID-YYYY-NNNN codes
-- Uses the year from created_at and assigns a sequence number ordered by creation date
WITH numbered AS (
  SELECT id,
         EXTRACT(YEAR FROM created_at)::int AS yr,
         ROW_NUMBER() OVER (ORDER BY created_at ASC) AS seq
  FROM profiles
  WHERE user_code IS NULL
)
UPDATE profiles
SET user_code = 'KID-' || numbered.yr || '-' || LPAD(numbered.seq::text, 4, '0')
FROM numbered
WHERE profiles.id = numbered.id;

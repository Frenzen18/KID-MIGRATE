-- Migration: record when the parent agreed to the Data Privacy Notice
-- (RA 10173). Shown once; skipped after it has been accepted.
-- Run this in Supabase Dashboard → SQL Editor.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS privacy_consent_at timestamptz;

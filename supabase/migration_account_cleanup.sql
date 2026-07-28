-- Migration: inactive-account cleanup tracking (dormant guardian signups
-- that never book an Initial Assessment get warned, then flagged for staff
-- review, then optionally deleted).
-- Run this in Supabase Dashboard -> SQL Editor.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deletion_warning_sent_at timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deletion_flagged_at timestamptz;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deletion_exempt boolean NOT NULL DEFAULT false;

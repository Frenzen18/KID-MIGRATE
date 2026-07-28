-- Migration: per-child inactivity-cleanup tracking. Complements
-- migration_account_cleanup.sql (which tracks the guardian account itself,
-- for a guardian who never links ANY child at all), this instead tracks each
-- individual linked child: a guardian with multiple children only ever risks
-- losing the specific child that never completes its own Initial Assessment,
-- not the whole account or any sibling that did.
-- Run this in Supabase Dashboard -> SQL Editor.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS deletion_warning_sent_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deletion_flagged_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS deletion_exempt boolean NOT NULL DEFAULT false;

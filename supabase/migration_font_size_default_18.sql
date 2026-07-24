-- Migration: bump the default site-wide text size from 16px to 18px, 16 read
-- as too small in practice. Existing clinics already have an explicit row
-- value (updated via the app), this only changes what a brand-new clinic
-- row defaults to if font_size is never set.
-- Run this in Supabase Dashboard → SQL Editor.

alter table branding_settings alter column font_size set default 18;

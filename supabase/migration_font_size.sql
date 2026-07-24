-- Migration: adjustable site-wide text size.
-- Typography previously only exposed Font Family (which cascades for free via
-- CSS inheritance). Actual font sizes are hardcoded in pixels all over the
-- app's components, so a real "adjustable size" needs an explicit baseline
-- to scale from. Stored here as a whole-number pixel value (12-24, picked
-- from a Word-style size dropdown in Branding.jsx), applied everywhere via a
-- CSS zoom scale relative to 16px in client/src/theme.js + shared.css.
-- Run this in Supabase Dashboard → SQL Editor.

alter table branding_settings add column if not exists font_size integer not null default 16
  check (font_size between 12 and 24);

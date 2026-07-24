-- Migration: per-post photo attribution for News Post thumbnails on the public
-- landing page ("News & Announcements" section). The homepage hero photo and
-- Our Approach photo already store their credit inside the existing JSON blob
-- (cms_posts row with category = '_homepage'), this is the one photo field
-- that's per-row instead, so it needs its own column.
--
-- Run this in Supabase Dashboard → SQL Editor.

alter table cms_posts add column if not exists photo_credit text;

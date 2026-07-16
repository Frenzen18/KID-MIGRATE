-- Migration: separate, independent color fields for the public landing page,
-- decoupled from the dashboard's Primary Color / Navbar Background Color /
-- Background Color (which now only affect the admin/staff/therapist/parent
-- portals). Defaults restore the landing page's original navy/cream look.
-- Run this in Supabase Dashboard → SQL Editor

alter table branding_settings add column if not exists landing_primary_color text not null default '#1F4E9E';
alter table branding_settings add column if not exists landing_navbar_bg_color text not null default '#FDFCFA';
alter table branding_settings add column if not exists landing_background_color text not null default '#FDFCFA';

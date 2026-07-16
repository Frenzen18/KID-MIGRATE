-- Migration: expand branding_settings into the full Branding & Theme module
-- (favicon, accent/background/card/text colors, navbar/footer colors, font,
-- login background). Adds columns to the existing singleton row created by
-- migration_branding_settings.sql. Hero banner is intentionally NOT here,
-- it's already managed via Homepage Management (cms_posts, category
-- '_homepage') in Cms.jsx, no need for a second, competing control.
-- Run this in Supabase Dashboard → SQL Editor

alter table branding_settings add column if not exists favicon_url text;
alter table branding_settings add column if not exists login_bg_url text;

alter table branding_settings add column if not exists accent_color text not null default '#F59E0B';
alter table branding_settings add column if not exists background_color text not null default '#F0F6FF';
alter table branding_settings add column if not exists card_color text not null default '#FFFFFF';
alter table branding_settings add column if not exists text_color text not null default '#0F172A';
alter table branding_settings add column if not exists navbar_bg_color text not null default '#FFFFFF';
alter table branding_settings add column if not exists navbar_text_color text not null default '#475569';
alter table branding_settings add column if not exists navbar_hover_color text not null default '#0EA5E9';
alter table branding_settings add column if not exists footer_bg_color text not null default '#182238';
alter table branding_settings add column if not exists footer_text_color text not null default '#CBD5E1';
alter table branding_settings add column if not exists font_family text not null default 'Inter';

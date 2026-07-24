-- Migration: structured clinic operating hours (weekday/Saturday start+end hour),
-- used to generate Initial Assessment slots independent of any specific
-- therapist's shift (intake has no dedicated therapist yet). Separate from the
-- existing free-text hours_weekdays/hours_saturday marketing display fields,
-- which stay as-is for the public landing/Settings page copy.
--
-- Run this in Supabase Dashboard → SQL Editor.

alter table branding_settings add column if not exists clinic_weekday_start_hour smallint default 8;
alter table branding_settings add column if not exists clinic_weekday_end_hour smallint default 18;
alter table branding_settings add column if not exists clinic_saturday_start_hour smallint default 9;
alter table branding_settings add column if not exists clinic_saturday_end_hour smallint default 15;

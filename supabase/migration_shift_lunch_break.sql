-- Migration: add an optional lunch break window to therapist shifts. Nullable,
-- a shift with no lunch break set behaves exactly as before. Run this in
-- Supabase Dashboard → SQL Editor.

alter table shifts add column if not exists lunch_start_hour int check (lunch_start_hour between 6 and 21);
alter table shifts add column if not exists lunch_end_hour int check (lunch_end_hour between 6 and 21);

do $$ begin
  alter table shifts add constraint shifts_lunch_order_check
    check (lunch_start_hour is null or lunch_end_hour is null or lunch_start_hour < lunch_end_hour);
exception when duplicate_object then null;
end $$;

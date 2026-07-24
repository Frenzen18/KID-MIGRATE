-- Migration: clinic-wide holidays/closures. Unlike the weekday/Saturday
-- operating hours (a fixed weekly pattern), holidays are specific one-off
-- calendar dates the clinic is entirely closed on, no bookings of any kind
-- (Initial Assessment or therapist-shift-driven sessions) are allowed that day.
--
-- Run this in Supabase Dashboard → SQL Editor.

create table if not exists clinic_holidays (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  label text,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id)
);

-- RLS on with no policies: only the service-role key (our Express server)
-- can read/write this table, same lockdown every other table in schema.sql
-- gets, anon/authenticated keys are blocked entirely.
alter table clinic_holidays enable row level security;

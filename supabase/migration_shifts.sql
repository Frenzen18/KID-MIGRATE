-- Migration: therapist shifts drive booking availability
-- Run this in Supabase Dashboard → SQL Editor
--
-- 1) shifts table — one row per therapist (start/end hour, 24h clock).
--    Slot capacity at any hour = number of therapists whose shift covers it.
create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  therapist_id uuid not null unique references profiles (id) on delete cascade,
  start_hour int not null default 8 check (start_hour between 6 and 20),
  end_hour int not null default 17 check (end_hour between 7 and 21),
  -- Working days Mon..Sat (availability matrix). false = day off, no bookings.
  work_days boolean[] not null default '{true,true,true,true,true,true}',
  room text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
-- (if you ran an earlier version of this migration without work_days:)
alter table shifts add column if not exists work_days boolean[] not null default '{true,true,true,true,true,true}';
alter table shifts enable row level security;

-- 2) Relax the booking guard: was "one active booking per date+slot",
--    now "one active booking per therapist per date+slot" so a slot can
--    hold as many sessions as there are therapists on shift.
drop index if exists reservations_active_slot_uidx;
create unique index if not exists reservations_active_slot_therapist_uidx
  on reservations (date, time_slot, therapist_name)
  where status not in ('cancelled', 'declined');

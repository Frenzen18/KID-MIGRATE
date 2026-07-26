-- Recurring therapy schedules: assigned by staff after a client's Initial
-- Assessment is completed. Generates a fixed batch of N weekly sessions on a
-- set day/time/therapist, see POST /api/reservations/:clientId/assign-schedule.
create table recurring_schedules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  discipline text not null check (discipline in ('OT', 'Speech')),
  day_of_week int not null check (day_of_week between 0 and 6), -- 0=Sunday .. 6=Saturday
  time_slot text not null,
  therapist_name text not null,
  sessions_authorized int not null check (sessions_authorized > 0),
  sessions_completed int not null default 0,
  status text not null default 'active' check (status in ('active', 'needs_reevaluation', 'discharged')),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id) on delete set null
);
create index recurring_schedules_client_idx on recurring_schedules (client_id);
-- Same pattern as every other table in this schema: RLS enabled, zero policies.
-- The app only ever talks to Postgres through the server's service-role key
-- (which bypasses RLS entirely), this just blocks any direct anon/authenticated
-- access as defense-in-depth, it's never meant to be reachable any other way.
alter table recurring_schedules enable row level security;

-- Which schedule (if any) a given reservation belongs to, one-off/manually
-- booked sessions (Initial Assessment, Re-evaluation Assessment, etc.) leave this null.
alter table reservations add column if not exists recurring_schedule_id uuid references recurring_schedules (id) on delete set null;

-- Distinguishes a per-session invoice from a no-show penalty charge, so both
-- can live in the same payments table/UI without conflating the two.
alter table payments add column if not exists fee_type text not null default 'session' check (fee_type in ('session', 'no_show_fee'));

-- A no-show fee is a second, separate payment on the SAME reservation (the
-- session invoice already generated at booking, plus now a penalty charge),
-- so the old one-payment-per-reservation unique index has to widen to allow
-- exactly one of each fee_type per reservation, not one payment total.
drop index if exists payments_reservation_uidx;
create unique index payments_reservation_uidx on payments (reservation_id, fee_type) where reservation_id is not null;

-- Only one client can actually occupy a given therapist's weekly hour, two
-- active schedules sharing the same day/time/therapist would just compete for
-- the same real calendar slot every week. Enforced at the DB level so a race
-- between two staff members can't both succeed.
create unique index recurring_schedules_active_slot_uidx on recurring_schedules (day_of_week, time_slot, therapist_name)
  where status = 'active';

-- A client waiting for a specific (day/time/therapist) slot that's already
-- taken by someone else's active schedule. FIFO by created_at within the same
-- slot; when that slot's schedule gets discharged, the earliest 'waiting' row
-- here gets notified the slot opened up (see PUT /recurring-schedules/:id).
create table schedule_waitlist (
  id uuid primary key default gen_random_uuid(),
  discipline text not null check (discipline in ('OT', 'Speech')),
  day_of_week int not null check (day_of_week between 0 and 6),
  time_slot text not null,
  therapist_name text not null,
  client_id uuid not null references clients (id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'notified', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id) on delete set null
);
create index schedule_waitlist_slot_idx on schedule_waitlist (day_of_week, time_slot, therapist_name, status);
create index schedule_waitlist_client_idx on schedule_waitlist (client_id);
-- Same pattern as every other table in this schema: RLS enabled, zero
-- policies, the app only ever talks to Postgres through the service-role key.
alter table schedule_waitlist enable row level security;

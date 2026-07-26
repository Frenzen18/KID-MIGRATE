-- Lets admin/staff manually mark a client's Initial Assessment as completed
-- (or not), independent of whether an actual "Initial Assessment" reservation
-- was ever booked/completed in-app. Needed for clients whose intake happened
-- before this system was in use, or to correct a data-entry mistake, without
-- staff having to fabricate a fake completed reservation just to unlock
-- schedule assignment.
alter table clients add column if not exists initial_assessment_completed boolean not null default false;

comment on column clients.initial_assessment_completed is
  'Manual admin/staff override: true means this client is treated as having completed their Initial Assessment for schedule-assignment eligibility, regardless of whether a matching reservation exists.';

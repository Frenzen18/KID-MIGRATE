-- Migration: add a real "assigned therapist" field to clients.
-- Previously the "Assigned Therapist" dropdown in Edit Client Profile had
-- nothing to save to — it was silently dropped on save. Caseload scoping
-- (Milestone Scoreboard, Client Records) is otherwise derived purely from
-- real reservation history; this column lets an admin/staff explicitly
-- assign a primary therapist even before any session has been booked.
alter table clients add column if not exists assigned_therapist_name text;

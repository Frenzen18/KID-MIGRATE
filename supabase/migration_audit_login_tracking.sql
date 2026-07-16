-- Migration: track sign-ins in the audit trail, so admin/staff can see how
-- many times a user has logged in (and when). Run this in Supabase
-- Dashboard → SQL Editor.
--
-- A login is modeled as a self-action: table_name='profiles',
-- record_id = the user's own id, created_by = the user's own id,
-- action = 'login'. No new table needed, reuses audit_logs.
-- Only counts logins from whenever this migration is applied onward,
-- there is no historical login data to backfill.

alter table audit_logs drop constraint if exists audit_logs_action_check;
alter table audit_logs add constraint audit_logs_action_check
  check (action in ('create', 'update', 'delete', 'approve', 'login'));

-- Migration: allow 'archive' as an audit_logs.action value.
-- Without this, logAudit() silently fails (by design, it never throws) whenever
-- clients/gas_entries archive routes try to record an 'archive' audit event,
-- so those actions vanish from Security Audit Logs instead of erroring loudly.
-- Run this in Supabase Dashboard → SQL Editor

alter table audit_logs drop constraint if exists audit_logs_action_check;
alter table audit_logs add constraint audit_logs_action_check
  check (action in ('create','update','delete','approve','archive','login'));

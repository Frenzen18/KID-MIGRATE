-- Migration: central audit trail (created_by / updated_by / approved_by)
-- Run this in Supabase Dashboard → SQL Editor
--
-- One row per event (create/update/approve/delete) on the main mutating
-- tables (profiles, clients, reservations, payments). Each row records who
-- performed it and when — created_by/created_at always; updated_by/updated_at
-- for edits and deletes; approved_by/approved_at when a reservation is
-- confirmed or a payment is marked paid.
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id text,
  action text not null check (action in ('create','update','delete','approve')),
  description text,
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references profiles (id) on delete set null,
  updated_at timestamptz,
  approved_by uuid references profiles (id) on delete set null,
  approved_at timestamptz
);
create index if not exists audit_logs_created_at_idx on audit_logs (created_at desc);
create index if not exists audit_logs_table_record_idx on audit_logs (table_name, record_id);

alter table audit_logs enable row level security;

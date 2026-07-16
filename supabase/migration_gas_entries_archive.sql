-- Migration: soft-delete (archive) GAS session entries instead of permanently
-- removing them, so submitted assessments stay recoverable/auditable.
-- Run this in Supabase Dashboard → SQL Editor

alter table gas_entries add column if not exists archived boolean not null default false;
create index if not exists gas_entries_archived_idx on gas_entries (archived);

-- Migration: soft-delete (archive) client profiles instead of permanently
-- removing them, so records stay recoverable/auditable (mirrors gas_entries.archived).
-- Run this in Supabase Dashboard → SQL Editor

alter table clients add column if not exists archived boolean not null default false;
create index if not exists clients_archived_idx on clients (archived);

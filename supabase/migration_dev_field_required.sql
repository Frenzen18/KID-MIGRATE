-- Migration: admin-configurable "required" flag on Development & Functional
-- Information fields. Defaults to false, so nothing changes for existing
-- fields until an admin opts one in via Manage Fields.
-- Run this in Supabase Dashboard → SQL Editor

alter table dev_functional_fields add column if not exists required boolean not null default false;

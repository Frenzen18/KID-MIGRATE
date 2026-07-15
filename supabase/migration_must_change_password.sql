-- Adds the forced-password-change flag for admin-created accounts.
-- Run in: Supabase Dashboard → SQL Editor.
-- Safe to re-run — IF NOT EXISTS guards the column add.

alter table profiles
  add column if not exists must_change_password boolean not null default false;

comment on column profiles.must_change_password is
  'True when the account was created by an admin with a temporary password. '
  'The user is required to set their own password on first login before '
  'reaching their portal.';

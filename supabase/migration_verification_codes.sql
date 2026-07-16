-- Migration: durable email-verification / password-reset codes
-- Run this in Supabase Dashboard → SQL Editor
--
-- Previously these 6-digit codes lived only in server memory (a Map in
-- routes/auth.js), so any server restart or redeploy between sending a code
-- and the user entering it would wipe it, "Invalid or expired code" even
-- when typed correctly within the TTL. One row per (email, purpose); a new
-- code for the same email+purpose replaces the previous one (upsert), same
-- semantics as the old Map.set().
create table if not exists verification_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null check (purpose in ('email_verify', 'password_reset')),
  code text not null,
  user_id uuid references profiles (id) on delete cascade,
  full_name text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (email, purpose)
);
create index if not exists verification_codes_email_purpose_idx on verification_codes (email, purpose);

alter table verification_codes enable row level security;
-- No policies: only the server's service-role key touches this table.

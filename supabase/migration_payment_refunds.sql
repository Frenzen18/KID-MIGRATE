-- Migration: real refund flow — capture a reason, and free up the session.
-- Run this in Supabase Dashboard → SQL Editor
alter table payments add column if not exists refund_reason text;

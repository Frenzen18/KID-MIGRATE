-- Migration: scheduled notifications (admin-only feature — staff is
-- restricted to immediate send, enforced server-side in notifications.js).
-- Run this in Supabase Dashboard → SQL Editor
alter table notifications add column if not exists scheduled_for timestamptz;

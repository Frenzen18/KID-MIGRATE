-- Migration: cooldown enforcement for automated notification triggers
-- (12.4 Configuration "Min. interval between same-type notifs"). event_key
-- stores the notification_settings column name that fired the notification
-- (e.g. 'notify_payment_received'), so notifyEvent() can look up recent
-- same-type notifications to the same target and skip if inside the window.
-- Manual 12.3 pushes leave this null — cooldown only applies to automated events.
-- Run this in Supabase Dashboard → SQL Editor
alter table notifications add column if not exists event_key text;
create index if not exists notifications_event_key_idx on notifications (event_key, target_user, target_role, created_at);

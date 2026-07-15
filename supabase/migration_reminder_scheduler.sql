-- Migration: session/balance reminder scheduler support.
-- Every other event type in notification_settings has its own on/off toggle;
-- session reminders were missing one. Also adds per-row "last reminded"
-- tracking so the sweep in server/lib/reminders.js can send each session
-- reminder exactly once, and each balance reminder at most once per the
-- configured frequency, instead of re-notifying on every sweep.
alter table notification_settings add column if not exists notify_session_reminder boolean not null default true;
alter table reservations add column if not exists reminder_sent_at timestamptz;
alter table payments add column if not exists last_reminder_at timestamptz;

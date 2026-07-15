-- Migration: real sender/recipient tracking on notifications (12.3/12.5) +
-- a real, persisted notification settings table (12.4).
-- Run this in Supabase Dashboard → SQL Editor

-- Who triggered this notification (null = system-generated, e.g. shift changes).
alter table notifications add column if not exists created_by uuid references profiles (id) on delete set null;

-- A real FK on target_user lets PostgREST embed the recipient's name.
-- Defensive null-out first in case any dev/test rows point at a deleted user.
update notifications set target_user = null
  where target_user is not null and target_user not in (select id from profiles);
alter table notifications drop constraint if exists notifications_target_user_fkey;
alter table notifications add constraint notifications_target_user_fkey
  foreign key (target_user) references profiles (id) on delete set null;

-- Singleton settings row for the 12.4 Configuration tab.
create table if not exists notification_settings (
  id int primary key default 1 check (id = 1),
  notify_booking_request boolean not null default true,
  notify_payment_received boolean not null default true,
  notify_scorecard_submitted boolean not null default true,
  notify_reschedule_request boolean not null default true,
  notify_session_cancellation boolean not null default true,
  notify_shift_reassignment boolean not null default true,
  notify_session_change boolean not null default true,
  notify_balance_reminder boolean not null default true,
  cooldown_minutes int not null default 30,
  balance_reminder_frequency_days int not null default 3,
  session_reminder_lead_hours int not null default 24,
  channel_in_app boolean not null default true,
  channel_email boolean not null default true,
  channel_sms boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles (id) on delete set null
);
insert into notification_settings (id) values (1) on conflict (id) do nothing;
alter table notification_settings enable row level security;

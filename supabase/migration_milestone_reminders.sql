-- Migration: remind a therapist to log a Milestone (GAS) entry for a session
-- that already happened, and flag entries logged after the 1-day grace window
-- as late. Requires linking a GAS entry back to the specific reservation it's
-- for, that link never existed before, a GAS entry was just a free-typed date.
-- Run this in Supabase Dashboard → SQL Editor.

-- Which booking this entry is for (auto-matched server-side by client + session
-- date + therapist at submit time, see server/routes/gas.js). Nullable: older
-- entries, and any entry for a session with no matching reservation row (e.g.
-- an ad-hoc/manual historical entry), simply have no link and are never
-- flagged late since there's nothing to compare against.
alter table gas_entries add column if not exists reservation_id uuid references reservations (id) on delete set null;
alter table gas_entries add column if not exists is_late boolean;
create index if not exists gas_entries_reservation_idx on gas_entries (reservation_id);

-- Marks a reservation once its "please log the milestone" reminder has been
-- sent, so the daily sweep (server/lib/reminders.js) never re-sends it.
alter table reservations add column if not exists milestone_reminder_sent_at timestamptz;

-- Same per-event on/off toggle pattern as every other reminder type.
alter table notification_settings add column if not exists notify_milestone_reminder boolean not null default true;

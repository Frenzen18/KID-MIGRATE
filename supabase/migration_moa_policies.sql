-- Whether a no-show or a cancellation was for a legitimate/excused reason,
-- persisted (not just acted on in the moment) so later logic can look back at
-- a client's last 3 outcomes on a schedule and tell "3 excused" (retainer
-- fee) apart from "3 unexcused" (slot forfeiture). Null = not applicable
-- (any other status, e.g. completed).
alter table reservations add column if not exists no_show_excused boolean;

-- Dedupes the monthly 50%-attendance monitoring notification, only fires once
-- per calendar month per schedule instead of every time the sweep runs.
alter table recurring_schedules add column if not exists last_monthly_attendance_check date;

-- A third fee type: the MOA's 50%-of-session-rate retainer fee, charged once
-- when 3 consecutive EXCUSED absences threaten a slot (as opposed to
-- no_show_fee, the flat penalty for a single UNEXCUSED miss). Postgres's
-- default naming for a column CHECK added via a bare `add column ... check`
-- is `<table>_<column>_check`, matching how fee_type's original constraint
-- was created (see migration_recurring_schedules.sql).
alter table payments drop constraint if exists payments_fee_type_check;
alter table payments add constraint payments_fee_type_check check (fee_type in ('session', 'no_show_fee', 'retainer_fee'));

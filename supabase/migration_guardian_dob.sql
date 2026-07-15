-- Migration: guardian/caretaker age -> date of birth.
-- Previously guardians typed their age directly (a number that goes stale
-- every birthday and can't be cross-checked). Switching to date of birth
-- lets the app compute a stable, accurate age server-side, the same way it
-- already does for the child, while still enforcing "must be an adult".
alter table clients add column if not exists guardian_dob date;

-- Best-effort backfill for existing rows: approximate birth year from the
-- age on file (exact day/month is unrecoverable), anchored to Jan 1 so the
-- computed age from this date is never overstated.
update clients
set guardian_dob = make_date(extract(year from current_date)::int - guardian_age, 1, 1)
where guardian_dob is null and guardian_age is not null;

alter table clients drop column if exists guardian_age;

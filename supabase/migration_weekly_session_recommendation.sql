-- How many sessions per week staff recommends for each discipline, set once
-- and independent of how many therapists end up fulfilling it (the clinic's
-- policy is one session per therapist per week, so a 2x/week recommendation
-- needs two different therapists' schedules assigned to cover it). Null means
-- no recommendation on file yet, no cap is enforced in that case.
alter table clients add column if not exists recommended_ot_weekly_sessions int check (recommended_ot_weekly_sessions between 1 and 7);
alter table clients add column if not exists recommended_speech_weekly_sessions int check (recommended_speech_weekly_sessions between 1 and 7);

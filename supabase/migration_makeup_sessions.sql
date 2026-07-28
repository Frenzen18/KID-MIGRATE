-- Marks a reservation as a make-up session: a one-off addition booked into
-- whatever open gap a client's already-assigned therapist happens to have
-- that day, deliberately NOT restricted to the client's own fixed
-- day/time (unlike a regular Occupational/Speech Therapy booking), see
-- POST /reservations' is_makeup handling in server/routes/reservations.js.
alter table reservations add column if not exists is_makeup boolean not null default false;

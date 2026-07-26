-- Recurring schedules no longer carry a fixed session count, nobody can
-- predict up front how many sessions a child will actually need, so the
-- day/time/therapist assignment just applies indefinitely (status stays
-- 'active') until staff discharges it by hand. sessions_authorized becomes
-- optional; a null check constraint already allows null through (Postgres
-- CHECK treats NULL as passing), so only the NOT NULL needs dropping.
alter table recurring_schedules alter column sessions_authorized drop not null;

-- payments.reservation_id was already nullable (see schema.sql), this is just
-- documenting the new meaning: a 'paid' session-fee payment with a null
-- reservation_id is an unattached credit (from an excused no-show whose
-- session was already paid), waiting to be applied to whichever session the
-- guardian books next (see ensurePaymentForReservation in reservations.js).
comment on column payments.reservation_id is 'Null + status=paid + fee_type=session means an unattached credit from an excused no-show, auto-applied to the client''s next booked session.';

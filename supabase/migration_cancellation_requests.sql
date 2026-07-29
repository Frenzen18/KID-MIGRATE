-- Migration: guardian-submitted cancellation requests for a fixed Speech/OT
-- weekly slot's specific week's occurrence, with an attached proof file, for
-- staff/admin to review as Excused or Unexcused (see applyCancellationReviewSideEffects
-- in server/lib/noShow.js and the review routes in server/routes/reservations.js).
-- Distinct from a direct staff/admin cancel (existing applyCancelSideEffects,
-- always treated as excused/legitimate) -- this table exists specifically for
-- the guardian-initiated, staff-reviewed path with a paper trail (attachment +
-- reviewer + verdict), since these fixed slots are no longer guardian-cancellable
-- outright once assigned.
-- Run this in Supabase Dashboard -> SQL Editor.

create table cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references reservations (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  requested_by uuid references profiles (id) on delete set null,
  attachment_path text not null,
  attachment_bucket text not null default 'cancellation-attachments',
  note text,
  status text not null default 'pending' check (status in ('pending', 'excused', 'unexcused')),
  reviewed_by uuid references profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

-- One live request per reservation at a time, a guardian re-submitting after
-- a reviewed one just leaves the old row as history rather than colliding.
create unique index cancellation_requests_pending_uidx on cancellation_requests (reservation_id) where status = 'pending';
create index cancellation_requests_client_idx on cancellation_requests (client_id);
create index cancellation_requests_status_idx on cancellation_requests (status);

alter table cancellation_requests enable row level security;

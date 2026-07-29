-- Adds a third review verdict to cancellation_requests: 'continued', for when
-- staff/admin reviews a guardian's cancellation request and decides the
-- session should proceed as originally scheduled instead of being treated as
-- excused or unexcused (e.g. the guardian's stated reason doesn't hold up, or
-- they change their mind after submitting). Unlike excused/unexcused, this
-- verdict does NOT cancel the underlying reservation and applies no fee/credit
-- side effects at all, see the 'continued' branch in PUT
-- /reservations/cancellation-requests/:id/review (server/routes/reservations.js)
-- and applyCancellationReviewSideEffects in server/lib/noShow.js.
-- Run this in Supabase Dashboard -> SQL Editor.

alter table cancellation_requests drop constraint if exists cancellation_requests_status_check;
alter table cancellation_requests add constraint cancellation_requests_status_check
  check (status in ('pending', 'excused', 'unexcused', 'continued'));

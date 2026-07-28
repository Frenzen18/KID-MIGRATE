-- A waitlist offer now has a real response instead of just 'notified' sitting
-- there forever: 'accepted' (the guardian claimed the slot, see POST
-- /schedule-waitlist/:id/accept) or 'declined' (POST .../decline, or the slot
-- turned out to already be taken when they tried to accept it), which cascades
-- to notifying the next person in line for that exact slot, same as a discharge.
alter table schedule_waitlist drop constraint if exists schedule_waitlist_status_check;
alter table schedule_waitlist add constraint schedule_waitlist_status_check
  check (status in ('waiting', 'notified', 'accepted', 'declined', 'cancelled'));

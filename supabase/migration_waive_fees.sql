-- Lets a no-show or retainer fee be marked "waived" (forgiven, no payment
-- required) instead of only ever paid/pending/overdue/refunded. Purely a
-- financial state, separate from the underlying reservation's excused/
-- unexcused status and the 3-consecutive-absence policy, see
-- server/routes/payments.js's POST /:id/waive.
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('paid', 'pending', 'overdue', 'refunded', 'waived'));

alter table payments add column if not exists waive_reason text;

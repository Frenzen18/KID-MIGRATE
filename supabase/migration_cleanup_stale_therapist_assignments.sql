-- One-time cleanup: clear assigned_ot_therapist_name, assigned_speech_therapist_name,
-- and therapy_type for clients whose schedules were already discharged BEFORE the
-- server-side fix was deployed (dischargeSchedule now handles this going forward).
-- Run this in Supabase Dashboard -> SQL Editor.

-- Clear OT therapist for clients with NO active OT schedule
update clients
set assigned_ot_therapist_name = null
where assigned_ot_therapist_name is not null
  and id not in (
    select client_id from recurring_schedules
    where discipline = 'OT' and status = 'active'
  );

-- Clear Speech therapist for clients with NO active Speech schedule
update clients
set assigned_speech_therapist_name = null
where assigned_speech_therapist_name is not null
  and id not in (
    select client_id from recurring_schedules
    where discipline = 'Speech' and status = 'active'
  );

-- Recompute therapy_type based on what's actually still active:
-- Both = has active OT AND Speech schedules
-- OT   = only active OT schedules
-- Speech = only active Speech schedules
-- null = no active schedules at all
update clients
set therapy_type = case
  when id in (select client_id from recurring_schedules where discipline = 'OT' and status = 'active')
   and id in (select client_id from recurring_schedules where discipline = 'Speech' and status = 'active')
  then 'Both'
  when id in (select client_id from recurring_schedules where discipline = 'OT' and status = 'active')
  then 'OT'
  when id in (select client_id from recurring_schedules where discipline = 'Speech' and status = 'active')
  then 'Speech'
  else null
end
where therapy_type is not null;

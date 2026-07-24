-- Combined (OT + Speech) clients need two independent assigned-therapist
-- slots instead of one shared field, so each discipline can be staffed
-- separately and the client can hold one OT session + one Speech session
-- on the same day.
alter table clients add column if not exists assigned_ot_therapist_name text;
alter table clients add column if not exists assigned_speech_therapist_name text;

-- Backfill from the old single field: route each existing assignment into
-- whichever new column matches that therapist's own registered role. The
-- old column is left in place afterward (unused going forward, not dropped).
update clients c
set assigned_ot_therapist_name = c.assigned_therapist_name
from profiles p
where p.full_name = c.assigned_therapist_name
  and p.role = 'ot'
  and c.assigned_therapist_name is not null;

update clients c
set assigned_speech_therapist_name = c.assigned_therapist_name
from profiles p
where p.full_name = c.assigned_therapist_name
  and p.role = 'speech'
  and c.assigned_therapist_name is not null;

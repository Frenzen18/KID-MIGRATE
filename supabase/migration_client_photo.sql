-- A guardian-uploaded photo of the child, shown on the guardian's own
-- Dashboard and in the client record admin/staff/therapists see, so
-- therapists can recognize the child by face.
alter table clients add column if not exists photo_url text;

-- Migration: Communication section improvements
-- Run this in Supabase Dashboard → SQL Editor
--
-- 1. New field_type 'select_other': a dropdown that always gets an implicit
--    trailing "Others" option; picking it reveals a free-text box. Used here
--    for "Primary mode of communication" (Sign Language, PECS, AAC device,
--    etc.), which only makes sense once "Verbal" is answered "No" — that
--    conditional is handled client-side (client/src/components/DevFunctionalField.jsx),
--    keyed by these two labels, not a generic admin-configurable dependency.
-- 2. "Follows directions" moves from "Behavior & Social" into "Communication",
--    it's a communication-comprehension question, not a behavior one.

alter table dev_functional_fields drop constraint if exists dev_functional_fields_field_type_check;
alter table dev_functional_fields add constraint dev_functional_fields_field_type_check
  check (field_type in ('select', 'text', 'select_other'));

update dev_functional_fields
  set field_type = 'select_other',
      options = '["Sign Language","Gestures/Pointing","Picture Exchange (PECS)","AAC Device/App","Written Words","Facial Expressions/Body Language"]'::jsonb,
      updated_at = now()
  where label = 'Primary mode of communication' and section = 'Communication';

update dev_functional_fields
  set section = 'Communication', sort_order = 7, updated_at = now()
  where label = 'Follows directions' and section = 'Behavior & Social';

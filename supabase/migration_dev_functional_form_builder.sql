-- Migration: Development & Functional Information becomes an admin-configurable
-- form instead of 12 fixed columns. Admin can now add/rename/remove fields and
-- their options via the Form Builder; the parent-facing linking form and
-- Client Records display/edit both render dynamically from this table.
--
-- Run this in Supabase Dashboard → SQL Editor.

create table if not exists dev_functional_fields (
  id uuid primary key default gen_random_uuid(),
  section text not null,                                   -- grouping label, e.g. "Self-Care Skills"
  label text not null,                                      -- the question, e.g. "Able to dress independently"
  field_type text not null check (field_type in ('select','text')),
  options jsonb,                                            -- array of strings, only for field_type = 'select'
  sort_order int not null default 0,
  active boolean not null default true,                     -- soft-delete: historical client data stays, field stops showing
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles (id) on delete set null
);

alter table clients add column if not exists dev_functional_data jsonb not null default '{}'::jsonb;

-- Seed the original 12 fields (same order/options as the fixed-column version)
-- so nothing changes visually until an admin customizes the form, and fold any
-- already-collected values from the old fixed columns into the new jsonb shape.
do $$
declare
  f_dress uuid; f_eat uuid; f_toileting uuid;
  f_verbal uuid; f_primary_mode uuid; f_understands uuid;
  f_behavior_concerns uuid; f_follows uuid; f_interacts uuid; f_sensory uuid;
  f_walks uuid; f_fine_motor uuid;
begin
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Self-Care Skills', 'Able to dress independently', 'select', '["Yes","No","With Support"]', 1)
    returning id into f_dress;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Self-Care Skills', 'Able to eat independently', 'select', '["Yes","No","With Support"]', 2)
    returning id into f_eat;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Self-Care Skills', 'Toileting', 'select', '["Independent","Needs Assistance","Not Trained"]', 3)
    returning id into f_toileting;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Communication', 'Verbal', 'select', '["Yes","No","Limited"]', 4)
    returning id into f_verbal;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Communication', 'Primary mode of communication', 'text', null, 5)
    returning id into f_primary_mode;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Communication', 'Understands instructions', 'select', '["Yes","No","Sometimes"]', 6)
    returning id into f_understands;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Behavior & Social', 'Behavior concerns', 'text', null, 7)
    returning id into f_behavior_concerns;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Behavior & Social', 'Follows directions', 'select', '["Yes","No","With Support"]', 8)
    returning id into f_follows;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Behavior & Social', 'Interacts with others', 'select', '["Easily","Needs Support","Limited"]', 9)
    returning id into f_interacts;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Behavior & Social', 'Sensory sensitivities (noise, touch, etc.)', 'text', null, 10)
    returning id into f_sensory;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Motor Skills', 'Walks independently', 'select', '["Yes","No","With Support"]', 11)
    returning id into f_walks;
  insert into dev_functional_fields (section, label, field_type, options, sort_order)
    values ('Motor Skills', 'Fine motor concerns (grasping, writing, etc.)', 'text', null, 12)
    returning id into f_fine_motor;

  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_dress::text, self_care_dress) where self_care_dress is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_eat::text, self_care_eat) where self_care_eat is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_toileting::text, self_care_toileting) where self_care_toileting is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_verbal::text, comm_verbal) where comm_verbal is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_primary_mode::text, comm_primary_mode) where comm_primary_mode is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_understands::text, comm_understands_instructions) where comm_understands_instructions is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_behavior_concerns::text, behavior_concerns) where behavior_concerns is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_follows::text, behavior_follows_directions) where behavior_follows_directions is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_interacts::text, behavior_interacts_others) where behavior_interacts_others is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_sensory::text, behavior_sensory_sensitivities) where behavior_sensory_sensitivities is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_walks::text, motor_walks_independently) where motor_walks_independently is not null;
  update clients set dev_functional_data = dev_functional_data || jsonb_build_object(f_fine_motor::text, motor_fine_motor_concerns) where motor_fine_motor_concerns is not null;
end $$;

alter table clients drop column if exists self_care_dress;
alter table clients drop column if exists self_care_eat;
alter table clients drop column if exists self_care_toileting;
alter table clients drop column if exists comm_verbal;
alter table clients drop column if exists comm_primary_mode;
alter table clients drop column if exists comm_understands_instructions;
alter table clients drop column if exists behavior_concerns;
alter table clients drop column if exists behavior_follows_directions;
alter table clients drop column if exists behavior_interacts_others;
alter table clients drop column if exists behavior_sensory_sensitivities;
alter table clients drop column if exists motor_walks_independently;
alter table clients drop column if exists motor_fine_motor_concerns;

alter table dev_functional_fields enable row level security;

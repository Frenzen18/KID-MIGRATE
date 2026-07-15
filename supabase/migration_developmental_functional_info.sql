-- Migration: Development & Functional Information intake fields.
-- Captured when a parent links/registers a child (self-register form), shown
-- in Client Records, and editable by admin/staff afterward.
alter table clients add column if not exists self_care_dress text;                 -- Yes / No / With Support
alter table clients add column if not exists self_care_eat text;                   -- Yes / No / With Support
alter table clients add column if not exists self_care_toileting text;             -- Independent / Needs Assistance / Not Trained
alter table clients add column if not exists comm_verbal text;                     -- Yes / No / Limited
alter table clients add column if not exists comm_primary_mode text;               -- free text
alter table clients add column if not exists comm_understands_instructions text;   -- Yes / No / Sometimes
alter table clients add column if not exists behavior_concerns text;               -- free text
alter table clients add column if not exists behavior_follows_directions text;     -- Yes / No / With Support
alter table clients add column if not exists behavior_interacts_others text;       -- Easily / Needs Support / Limited
alter table clients add column if not exists behavior_sensory_sensitivities text;  -- free text
alter table clients add column if not exists motor_walks_independently text;      -- Yes / No / With Support
alter table clients add column if not exists motor_fine_motor_concerns text;       -- free text

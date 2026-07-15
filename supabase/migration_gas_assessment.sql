-- Migration: GAS (Goal Attainment Scaling) assessment questionnaire tool —
-- admin-editable, versioned goal sets per discipline (Speech-Language Therapy /
-- Occupational Therapy), scored per client session with a computed T-score.
-- Run this in Supabase Dashboard → SQL Editor

create table if not exists gas_questionnaires (
  id uuid primary key default gen_random_uuid(),
  discipline text not null check (discipline in ('Speech-Language Therapy','Occupational Therapy')),
  name text not null,               -- admin-chosen label, e.g. "Standard OT Goals — v1"
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id) on delete set null
);

create table if not exists gas_questionnaire_items (
  id uuid primary key default gen_random_uuid(),
  questionnaire_id uuid not null references gas_questionnaires (id) on delete cascade,
  title text not null,
  description text,
  level_m2 text not null,  -- -2 much less than expected
  level_m1 text not null,  -- -1 somewhat less than expected
  level_0  text not null,  --  0 expected level of outcome
  level_p1 text not null,  -- +1 somewhat more than expected
  level_p2 text not null,  -- +2 much more than expected
  weight numeric not null default 1 check (weight > 0),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists gas_questionnaire_items_qid_idx on gas_questionnaire_items (questionnaire_id, sort_order);

create table if not exists gas_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  questionnaire_id uuid references gas_questionnaires (id) on delete set null,
  discipline text not null,
  questionnaire_name text not null,   -- snapshot: survives set rename/delete
  session_date date not null,
  therapist_name text,
  remarks text,
  gas_t_score numeric,                -- computed Kiresuk & Sherman T-score
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id) on delete set null
);
create index if not exists gas_entries_client_idx on gas_entries (client_id, session_date);

create table if not exists gas_entry_scores (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references gas_entries (id) on delete cascade,
  item_id uuid references gas_questionnaire_items (id) on delete set null,
  item_title text not null,   -- snapshot: survives item edit/delete
  weight numeric not null,    -- snapshot
  level int not null check (level between -2 and 2),
  level_label text not null   -- snapshot of the chosen level's description text
);
create index if not exists gas_entry_scores_entry_idx on gas_entry_scores (entry_id);

alter table gas_questionnaires enable row level security;
alter table gas_questionnaire_items enable row level security;
alter table gas_entries enable row level security;
alter table gas_entry_scores enable row level security;

-- ============================================================
-- KID Clinic — Supabase schema
-- Paste this whole file into: Supabase Dashboard → SQL Editor → Run
-- Safe to re-run (drops and recreates the app tables).
-- ============================================================

drop table if exists verification_codes cascade;
drop table if exists gas_entry_scores cascade;
drop table if exists gas_entries cascade;
drop table if exists gas_questionnaire_items cascade;
drop table if exists gas_questionnaires cascade;
drop table if exists audit_logs cascade;
drop table if exists shifts cascade;
drop table if exists notifications cascade;
drop table if exists payments cascade;
drop table if exists announcements cascade;
drop table if exists cms_posts cascade;
drop table if exists attendance cascade;
drop table if exists session_notes cascade;
drop table if exists reservations cascade;
drop table if exists clients cascade;
drop table if exists profiles cascade;

-- Portal accounts (mirrors auth.users; role drives portal routing)
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  user_code text unique,
  email text not null,
  first_name text,
  last_name text,
  full_name text not null, -- display value, kept in sync as first_name || ' ' || last_name
  contact text,            -- normalized 09XXXXXXXXX; checked for duplicates on signup
  privacy_consent_at timestamptz, -- when the RA 10173 notice was accepted (intake consent shown once)
  role text not null check (role in ('admin','staff','ot','speech','parent')),
  active boolean not null default true,
  must_change_password boolean not null default false, -- set on admin-created accounts; cleared once the user sets their own password
  created_at timestamptz not null default now()
);

-- Children / clients of the clinic
create table clients (
  id uuid primary key default gen_random_uuid(),
  client_code text not null unique,
  first_name text,
  middle_name text,
  last_name text,
  full_name text not null, -- display value, kept in sync as first_name || ' ' || last_name
  dob date,
  gender text,
  guardian_name text,
  guardian_contact text,
  parent_id uuid references profiles (id) on delete set null,
  diagnosis text,
  therapy_type text check (therapy_type in ('OT','Speech','Both')), -- null = for assessment; assigned by the clinic
  status text not null default 'active' check (status in ('active','recovered','discontinued','on_hold')),
  enrolled_at date not null default current_date,
  created_at timestamptz not null default now(),
  -- Intake form fields
  medical_conditions text,
  allergies text,
  daily_medication text,
  guardian_relationship text check (guardian_relationship in ('Parent','Guardian','Caretaker')),
  guardian_dob date,
  guardian_phone text,
  other_guardian_name text,
  other_guardian_phone text,
  -- Development & Functional Information — keyed by dev_functional_fields.id,
  -- captured at linking, admin/staff/therapist-editable. An admin-configurable
  -- form (see dev_functional_fields below) rather than fixed columns, so the
  -- form's questions can be added/renamed/removed without a schema change.
  dev_functional_data jsonb not null default '{}'::jsonb
);

-- Admin-configurable "Development & Functional Information" form definition —
-- the parent-facing linking form and Client Records display/edit both render
-- from this table. See supabase/migration_dev_functional_form_builder.sql for
-- the seed data (12 default fields matching the clinic's original intake form).
create table dev_functional_fields (
  id uuid primary key default gen_random_uuid(),
  section text not null,
  label text not null,
  field_type text not null check (field_type in ('select','text','select_other')),
  options jsonb,
  required boolean not null default false, -- admin-configurable via Manage Fields; false = today's "every field optional" default
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles (id) on delete set null
);

-- Bookings (interactive calendar)
create table reservations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  therapist_name text,
  date date not null,
  time_slot text not null,
  session_type text not null default 'Occupational Therapy',
  duration_min int not null default 60,
  room text,
  status text not null default 'pending' check (status in ('awaiting_payment','pending','confirmed','rescheduled','cancelled','completed','declined','no_show')),
  channel text,
  notes text,
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  reminder_sent_at timestamptz, -- set once the pre-session reminder sweep (server/lib/reminders.js) has notified the guardian
  payment_expires_at timestamptz, -- deadline for an 'awaiting_payment' hold before it's auto-released, see server/lib/bookingHolds.js
  milestone_reminder_sent_at timestamptz -- set once the day-after sweep (server/lib/reminders.js) has told the therapist a Milestone entry is still missing for this session
);
create index reservations_date_idx on reservations (date, time_slot);
-- Real double-booking guard: the app-level check-then-insert has a race window,
-- so the database enforces at most one *active* reservation per therapist per
-- date+slot (slot capacity = number of therapists on shift at that hour).
-- Cancelled/declined/no-show rows are excluded so that slot becomes bookable again.
create unique index reservations_active_slot_therapist_uidx on reservations (date, time_slot, therapist_name)
  where status not in ('cancelled', 'declined', 'no_show');

-- Therapist shifts (3.2 Employee Scheduling) — drive booking availability.
-- Hours are on the 24h clock; the shift applies to every clinic day.
create table shifts (
  id uuid primary key default gen_random_uuid(),
  therapist_id uuid not null unique references profiles (id) on delete cascade,
  start_hour int not null default 8 check (start_hour between 6 and 20),
  end_hour int not null default 17 check (end_hour between 7 and 21),
  -- Optional lunch break, an hour range within the shift with no bookings.
  -- Null on both means no lunch break is set.
  lunch_start_hour int check (lunch_start_hour between 6 and 21),
  lunch_end_hour int check (lunch_end_hour between 6 and 21),
  -- Working days Mon..Sun (availability matrix). false = day off, no bookings.
  -- Sunday (7th element) defaults to closed; admins opt individual therapists in.
  work_days boolean[] not null default '{true,true,true,true,true,true,false}',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint shifts_lunch_order_check check (lunch_start_hour is null or lunch_end_hour is null or lunch_start_hour < lunch_end_hour)
);

-- Qualitative clinical observations (7.1.d.a hover notes)
create table session_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  therapist_name text,
  domain text not null,             -- Fine Motor | Speech & Language | Social & Behavioral | Cognitive
  session_date date not null,
  score int not null check (score between 0 and 100),
  remark text,
  next_plan text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index session_notes_client_idx on session_notes (client_id, session_date);

-- Attendance (7.1.d.c)
create table attendance (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  session_date date not null,
  attended boolean not null default true,
  created_at timestamptz not null default now()
);

-- Website content (CMS)
create table cms_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  category text not null default 'General',
  image_url text,
  status text not null default 'draft' check (status in ('published','draft','archived')),
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  starts_on date not null default current_date,
  ends_on date,
  status text not null default 'published' check (status in ('published','draft')),
  created_at timestamptz not null default now()
);

-- Payments / billing
create table payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  reservation_id uuid references reservations (id) on delete set null, -- session this invoice is for, if auto-generated on booking confirm
  amount numeric(10,2) not null,
  method text not null default 'Cash',
  reference text,
  status text not null default 'paid' check (status in ('paid','pending','overdue','refunded')),
  invoice_no text,
  sealed boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  refund_reason text,
  -- PayMongo QRPh state (see server/lib/paymongo.js)
  pm_payment_intent_id text,
  pm_client_key text,
  qr_image_url text,
  qr_expires_at timestamptz,
  qr_test_url text, -- PayMongo sandbox "Simulate Payment" link — reused alongside the QR so it isn't lost across re-opens
  last_reminder_at timestamptz -- last time the balance-reminder sweep (server/lib/reminders.js) notified the guardian
);
create index payments_reservation_idx on payments (reservation_id);
-- Real duplicate-invoice guard: ensurePaymentForReservation()'s check-then-insert
-- has a race window (concurrent requests, double-clicked Confirm), same pattern
-- as reservations_active_slot_therapist_uidx for double-booking.
create unique index payments_reservation_uidx on payments (reservation_id) where reservation_id is not null;
create unique index payments_pm_intent_uidx on payments (pm_payment_intent_id) where pm_payment_intent_id is not null;

-- Invoice numbers: a single global counter so numbers are strictly
-- incremental across the whole clinic (never random, never reused),
-- called from server/lib/billing.js via db.rpc('next_invoice_no').
create sequence if not exists invoice_no_seq start 1;
create or replace function next_invoice_no()
returns text
language sql
as $$
  select 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('invoice_no_seq')::text, 5, '0');
$$;

-- In-app notifications
create table notifications (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  icon text not null default 'fa-bell',
  target_role text,                 -- deliver to everyone with this role…
  target_user uuid references profiles (id) on delete set null, -- …or to one specific user
  created_by uuid references profiles (id) on delete set null,  -- who triggered it; null = system-generated
  scheduled_for timestamptz,        -- admin-only: hides the notification until this time (null = immediate)
  event_key text,                   -- notification_settings column that fired this (null = manual 12.3 push)
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_event_key_idx on notifications (event_key, target_user, target_role, created_at);

-- Singleton settings row for the admin Notifications "Configuration" tab (12.4).
create table notification_settings (
  id int primary key default 1 check (id = 1),
  notify_booking_request boolean not null default true,
  notify_payment_received boolean not null default true,
  notify_scorecard_submitted boolean not null default true,
  notify_reschedule_request boolean not null default true,
  notify_session_cancellation boolean not null default true,
  notify_shift_reassignment boolean not null default true,
  notify_session_change boolean not null default true,
  notify_balance_reminder boolean not null default true,
  notify_session_reminder boolean not null default true,
  notify_milestone_reminder boolean not null default true,
  cooldown_minutes int not null default 30,
  balance_reminder_frequency_days int not null default 3,
  session_reminder_lead_hours int not null default 24,
  channel_in_app boolean not null default true,
  channel_email boolean not null default true,
  channel_sms boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles (id) on delete set null
);
insert into notification_settings (id) values (1);

-- Central audit trail (created_by / updated_by / approved_by). One row per
-- event on the main mutating tables — see migration_audit_logs.sql for details.
create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id text,
  action text not null check (action in ('create','update','delete','approve','login')),
  description text,
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references profiles (id) on delete set null,
  updated_at timestamptz,
  approved_by uuid references profiles (id) on delete set null,
  approved_at timestamptz
);
create index audit_logs_created_at_idx on audit_logs (created_at desc);
create index audit_logs_table_record_idx on audit_logs (table_name, record_id);

-- GAS (Goal Attainment Scaling) assessment questionnaire tool — admin-editable,
-- versioned goal sets per discipline, scored per client session with a computed
-- T-score. See migration_gas_assessment.sql for details.
create table gas_questionnaires (
  id uuid primary key default gen_random_uuid(),
  discipline text not null check (discipline in ('Speech-Language Therapy','Occupational Therapy')),
  name text not null,               -- admin-chosen label, e.g. "Standard OT Goals — v1"
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id) on delete set null
);

create table gas_questionnaire_items (
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
create index gas_questionnaire_items_qid_idx on gas_questionnaire_items (questionnaire_id, sort_order);

create table gas_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  questionnaire_id uuid references gas_questionnaires (id) on delete set null,
  discipline text not null,
  questionnaire_name text not null,   -- snapshot: survives set rename/delete
  session_date date not null,
  therapist_name text,
  remarks text,
  gas_t_score numeric,                -- computed Kiresuk & Sherman T-score
  -- Which booking this entry is for (auto-matched by client + session date +
  -- therapist at submit time, see server/routes/gas.js), and whether it was
  -- logged more than a day after that session, both nullable: an entry with
  -- no matching reservation (ad-hoc/manual historical entry) has nothing to
  -- compare against, so it's never flagged late.
  reservation_id uuid references reservations (id) on delete set null,
  is_late boolean,
  created_at timestamptz not null default now(),
  created_by uuid references profiles (id) on delete set null
);
create index gas_entries_client_idx on gas_entries (client_id, session_date);
create index gas_entries_reservation_idx on gas_entries (reservation_id);

create table gas_entry_scores (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references gas_entries (id) on delete cascade,
  item_id uuid references gas_questionnaire_items (id) on delete set null,
  item_title text not null,   -- snapshot: survives item edit/delete
  weight numeric not null,    -- snapshot
  level int not null check (level between -2 and 2),
  level_label text not null   -- snapshot of the chosen level's description text
);
create index gas_entry_scores_entry_idx on gas_entry_scores (entry_id);

-- Email-verification / password-reset codes. One row per (email, purpose);
-- durable so a server restart between sending a code and the user entering
-- it doesn't invalidate it. See migration_verification_codes.sql for details.
create table verification_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null check (purpose in ('email_verify', 'password_reset')),
  code text not null,
  user_id uuid references profiles (id) on delete cascade,
  full_name text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (email, purpose)
);
create index verification_codes_email_purpose_idx on verification_codes (email, purpose);

-- Lock the tables down: RLS on with NO policies means only the
-- service-role key (our Express server) can read/write them.
alter table profiles enable row level security;
alter table clients enable row level security;
alter table reservations enable row level security;
alter table shifts enable row level security;
alter table session_notes enable row level security;
alter table attendance enable row level security;
alter table cms_posts enable row level security;
alter table announcements enable row level security;
alter table payments enable row level security;
alter table notifications enable row level security;
alter table audit_logs enable row level security;
alter table notification_settings enable row level security;
alter table gas_questionnaires enable row level security;
alter table gas_questionnaire_items enable row level security;
alter table gas_entries enable row level security;
alter table gas_entry_scores enable row level security;
alter table dev_functional_fields enable row level security;
alter table verification_codes enable row level security;

-- Seed the original 12 Development & Functional Information fields (fresh
-- installs only — an existing DB migrates via migration_dev_functional_form_builder.sql,
-- which also folds over any already-collected fixed-column data).
-- required = true on the core Yes/No assessment basics; free-text/notes
-- fields and the conditional "Primary mode of communication" stay optional.
insert into dev_functional_fields (section, label, field_type, options, required, sort_order) values
  ('Self-Care Skills', 'Able to dress independently', 'select', '["Yes","No","With Support"]', true, 1),
  ('Self-Care Skills', 'Able to eat independently', 'select', '["Yes","No","With Support"]', true, 2),
  ('Self-Care Skills', 'Toileting', 'select', '["Independent","Needs Assistance","Not Trained"]', true, 3),
  ('Communication', 'Verbal', 'select', '["Yes","No","Limited"]', true, 4),
  -- 'select_other': dropdown + an implicit "Others" option that reveals a text
  -- box. Only shown once "Verbal" above is answered "No" (client-side, see
  -- client/src/components/DevFunctionalField.jsx).
  ('Communication', 'Primary mode of communication', 'select_other', '["Sign Language","Gestures/Pointing","Picture Exchange (PECS)","AAC Device/App","Written Words","Facial Expressions/Body Language"]', false, 5),
  ('Communication', 'Understands instructions', 'select', '["Yes","No","Sometimes"]', true, 6),
  ('Communication', 'Follows directions', 'select', '["Yes","No","With Support"]', true, 7),
  ('Behavior & Social', 'Behavior concerns', 'text', null, false, 7),
  ('Behavior & Social', 'Interacts with others', 'select', '["Easily","Needs Support","Limited"]', true, 9),
  ('Behavior & Social', 'Sensory sensitivities (noise, touch, etc.)', 'text', null, false, 10),
  ('Motor Skills', 'Walks independently', 'select', '["Yes","No","With Support"]', true, 11),
  ('Motor Skills', 'Fine motor concerns (grasping, writing, etc.)', 'text', null, false, 12);

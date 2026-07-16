# Prompt: Settings-Driven CMS (single-clinic, deploy-per-client)

You are a senior full-stack engineer working on an existing clinic CMS (React client + Express server + Supabase/Postgres). This is **not** a multi-tenant system — each clinic client gets its own separate deployment and database. The goal is that a new deployment for a new client never requires source code changes, only configuration through the CMS.

**Do not redesign the existing UI.** Preserve the current dashboard layout, spacing, typography, sidebar, cards, buttons, icons, and design language (see `client/src/portals/admin`). New screens must match the existing look — same `card`, `form-input`, `form-select`, `btn-primary`/`btn-secondary`/`btn-edit`, `pill`/`pill-*` classes already used throughout.

## Objective

Move every clinic-specific hardcoded value (branding, colors, logo, payment accounts, scheduling rules, contact info) out of source code and into the database, editable through new CMS screens. There is exactly one clinic per deployment — no `clinic_id`, no tenant isolation, no super admin needed.

## 1. Branding & Theme Settings

New module: **Branding & Theme**, admin-only.

Fields:
- Clinic name, logo, favicon
- Theme colors (primary, secondary, accent, background, card, text, navbar bg/text/hover, footer bg/text, button colors)
- Font family
- Hero banner image, login background image

**Schema recommendation:** one `branding_settings` table with a single row, most theme values in a `theme jsonb` column rather than one column per color — adding a new themeable property later (e.g. a new button state) shouldn't require a migration.

```sql
create table branding_settings (
  id uuid primary key default gen_random_uuid(),
  clinic_name text not null,
  logo_url text,
  favicon_url text,
  hero_banner_url text,
  login_bg_url text,
  theme jsonb not null default '{}', -- { primary, secondary, accent, background, cardColor, textColor, navbarBg, navbarText, navbarHover, footerBg, footerText, buttonColors: {...} }
  font_family text default 'Inter',
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id)
);
```

Requirements:
- Load these values at app startup / root layout and apply as CSS variables (don't hardcode hex values in components going forward for anything theme-related).
- Live preview in the settings screen before saving (render a mock card/navbar/button using the pending, unsaved values).
- Logo/favicon/banner uploads go to Supabase Storage; validate file type (png/jpg/svg/ico as appropriate) and size before accepting.
- Restrict to `role = 'admin'` via the existing `requireRole('admin')` middleware pattern (see `server/middleware/auth.js`).

## 2. Payment Settings (configuration, not transactions)

**Important distinction:** this is separate from the existing `payments` table (`supabase/schema.sql:184`), which stores actual transaction/invoice records and already has an admin screen (`client/src/portals/admin/pages/Payments.jsx`). This new module is for the *configuration* those transactions are collected against — bank accounts, which methods are enabled, gateway keys. Do not touch the existing transactions table or its screen.

New tables:

```sql
create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  bank_name text not null,
  account_name text not null,
  account_number text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table payment_settings (
  id uuid primary key default gen_random_uuid(),
  bank_transfer_enabled boolean not null default true,
  gcash_enabled boolean not null default false,
  gcash_qr_url text,
  maya_enabled boolean not null default false,
  maya_qr_url text,
  paymongo_public_key text,
  paymongo_secret_key text, -- store encrypted / never returned to frontend
  test_mode boolean not null default true,
  invoice_prefix text default 'INV',
  receipt_footer_note text,
  updated_at timestamptz not null default now()
);
```

Requirements:
- CRUD for bank accounts (add/edit/delete/activate).
- Toggle each payment method on/off; toggles control what guardians see at checkout, sourced dynamically (no hardcoded `QRPh`/`Cash`/`Check` list — see `METHOD_CHANNEL` in `Payments.jsx` for the current hardcoded mapping that should become dynamic).
- `paymongo_secret_key` must never be sent to the frontend in any API response — write-only from the client's perspective.
- QR code uploads validated (image type, size) and stored in Supabase Storage.
- Admin-only.

## 3. Scheduling Settings

**Check before building:** therapist-level availability, shifts, and lunch breaks already exist (`supabase/migration_shifts.sql`, `migration_shift_lunch_break.sql`, `migration_shift_sunday.sql`, `server/routes/shifts.js`). This module adds *clinic-wide defaults*, not a replacement for per-therapist shifts.

```sql
create table scheduling_settings (
  id uuid primary key default gen_random_uuid(),
  operating_days jsonb not null default '["mon","tue","wed","thu","fri"]',
  opening_time time not null default '08:00',
  closing_time time not null default '17:00',
  lunch_break_start time,
  lunch_break_end time,
  holidays jsonb not null default '[]', -- array of ISO dates
  max_appointments_per_day int,
  appointment_duration_min int not null default 30,
  buffer_time_min int not null default 0,
  slot_interval_min int not null default 30,
  booking_window_days int not null default 30, -- how far ahead guardians can book
  allow_same_day_booking boolean not null default true,
  reschedule_cutoff_hours int default 24,
  cancellation_cutoff_hours int default 24,
  updated_at timestamptz not null default now()
);
```

Requirements:
- These are clinic-wide defaults/policy; per-therapist shifts (existing system) still govern actual availability within these bounds.
- Booking flow (wherever slots are generated for guardians) must read `slot_interval_min`, `buffer_time_min`, `booking_window_days`, `allow_same_day_booking`, cutoffs, and holidays from this table instead of any hardcoded constants — find and replace those constants.
- Admin-only.

## 4. Website / Contact Settings

```sql
create table website_settings (
  id uuid primary key default gen_random_uuid(),
  address text,
  phone text,
  email text,
  social_links jsonb default '{}',
  updated_at timestamptz not null default now()
);
```

Fold into the Branding module's UI as a second tab/section rather than a separate nav item — it's a single-row settings table like branding, no need for a separate top-level page.

## 5. General Requirements

- Every new settings table is a **single row** (no clinic_id, no multi-row per-clinic key) — enforce with a unique partial index or just document it's single-row by convention, matching this being a one-clinic-per-deployment system.
- All settings screens: admin-only (`requireRole('admin')`), with client-side + server-side validation on every form (required fields, color hex format, file types/sizes, numeric ranges for durations/buffers).
- Replace hardcoded values across the codebase with reads from these tables — grep for hardcoded hex colors, clinic name strings, and scheduling constants as part of this work, don't just add the settings screens and leave old constants in place unused.
- Reuse existing components/styles; no new design system.
- A new client deployment = fresh database + one-time fill-in of these settings tables through the CMS. No code change, no redeploy-time config beyond environment variables (Supabase URL/keys) that already exist today.

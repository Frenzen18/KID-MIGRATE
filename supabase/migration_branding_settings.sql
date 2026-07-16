-- Migration: singleton branding/clinic-info settings row for the admin
-- Settings page (Clinic Information + Branding cards), so those values are
-- editable through the CMS instead of hardcoded in Settings.jsx.
-- Run this in Supabase Dashboard → SQL Editor

create table if not exists branding_settings (
  id int primary key default 1 check (id = 1),
  clinic_name text not null default 'KID Clinic: Kids Integrated Development Center',
  address text,
  phone text,
  email text,
  hours_weekdays text,
  hours_saturday text,
  website_url text,
  logo_url text,
  primary_color text not null default '#0EA5E9',
  secondary_color text not null default '#0D9488',
  tagline text,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles (id) on delete set null
);

insert into branding_settings (
  id, clinic_name, address, phone, email, hours_weekdays, hours_saturday, website_url, primary_color, secondary_color, tagline
) values (
  1, 'KID Clinic: Kids Integrated Development Center', '123 Therapy Lane, Quezon City, Metro Manila 1100',
  '+63 2 8123 4567', 'info@kidclinic.ph', '8:00 AM – 5:00 PM', '8:00 AM – 12:00 PM', 'https://www.kidclinic.ph',
  '#0EA5E9', '#0D9488', 'Every Child Deserves to Thrive'
) on conflict (id) do nothing;

alter table branding_settings enable row level security;

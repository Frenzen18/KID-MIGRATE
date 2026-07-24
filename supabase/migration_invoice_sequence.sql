-- Migration: incremental invoice numbers.
-- Invoice numbers were previously suffixed with Math.random(), so two
-- invoices created the same day had no ordering guarantee and could even
-- collide. This adds a single global sequence so invoice_no always counts
-- up strictly (INV-YYYYMMDD-00001, -00002, ...), generated server-side via
-- db.rpc('next_invoice_no') in server/lib/billing.js.
--
-- Run this in Supabase Dashboard → SQL Editor.

create sequence if not exists invoice_no_seq start 1;

create or replace function next_invoice_no()
returns text
language sql
as $$
  select 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('invoice_no_seq')::text, 5, '0');
$$;

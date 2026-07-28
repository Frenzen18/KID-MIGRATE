-- Admin/staff-editable session prices (PHP), stored on the branding_settings
-- singleton row (id=1) alongside clinic hours, so promo/rate changes take
-- effect immediately without a deploy. Defaults mirror the previously
-- hardcoded rates in server/lib/billing.js.
ALTER TABLE branding_settings ADD COLUMN IF NOT EXISTS price_ot integer NOT NULL DEFAULT 1400;
ALTER TABLE branding_settings ADD COLUMN IF NOT EXISTS price_speech integer NOT NULL DEFAULT 1200;
ALTER TABLE branding_settings ADD COLUMN IF NOT EXISTS price_combined integer NOT NULL DEFAULT 2800;
ALTER TABLE branding_settings ADD COLUMN IF NOT EXISTS price_initial_assessment integer NOT NULL DEFAULT 1400;

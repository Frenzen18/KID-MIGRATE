-- Migration: sign up and sign in with a mobile number, for guardians who
-- don't have an email address. A password-only account still needs
-- SOMETHING in auth.users.email (Supabase Auth requires it), so a phone-only
-- signup gets a synthetic placeholder email (see server/phone.js,
-- syntheticEmailForPhone) the user never sees or types; profiles.phone_only
-- marks that this account's "email" isn't a real one, so the rest of the
-- app can tell not to display/use it as if it were.
-- Run this in Supabase Dashboard -> SQL Editor.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_only boolean NOT NULL DEFAULT false;

-- verification_codes previously only ever keyed by email (email_verify /
-- password_reset). A phone-only account has no email to send either kind of
-- code to, so it needs the same two purposes keyed by phone instead.
ALTER TABLE verification_codes ALTER COLUMN email DROP NOT NULL;
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE verification_codes ADD CONSTRAINT verification_codes_target_check CHECK (email IS NOT NULL OR phone IS NOT NULL);
ALTER TABLE verification_codes ADD CONSTRAINT verification_codes_phone_purpose_uidx UNIQUE (phone, purpose);

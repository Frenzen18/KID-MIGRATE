-- Migration: verification codes for self-service email/phone changes from
-- the guardian/caretaker "My Profile" panel. Previously PUT /api/auth/me
-- wrote a new contact number straight to profiles with no proof the caller
-- actually controls it, and there was no way to change the account email at
-- all. Two new verification_codes purposes reuse the exact same table/TTL/
-- cooldown machinery as signup/password-reset (see server/codes.js), just
-- keyed to the NEW email/phone rather than the account's current one, so the
-- change is only ever written once that target is confirmed.
-- Run this in Supabase Dashboard -> SQL Editor.

ALTER TABLE verification_codes DROP CONSTRAINT IF EXISTS verification_codes_purpose_check;
ALTER TABLE verification_codes ADD CONSTRAINT verification_codes_purpose_check
  CHECK (purpose IN ('email_verify', 'password_reset', 'profile_email', 'profile_phone'));

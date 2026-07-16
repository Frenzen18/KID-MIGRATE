-- Migration: mark the core Development & Functional Information questions
-- required (asterisk, blocks submission until answered). Free-text/notes
-- fields and the conditional "Primary mode of communication" stay optional.
-- Run this in Supabase Dashboard → SQL Editor
-- (requires migration_dev_field_required.sql to have been run first)

update dev_functional_fields set required = true, updated_at = now()
  where label in (
    'Able to dress independently',
    'Able to eat independently',
    'Toileting',
    'Verbal',
    'Understands instructions',
    'Follows directions',
    'Interacts with others',
    'Walks independently'
  );

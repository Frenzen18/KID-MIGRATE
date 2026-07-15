-- Migration: therapist discipline specialty (Occupational Therapy / Speech-Language
-- Therapy sub-roles). role stays 'therapist' for these accounts everywhere in the
-- app — specialty is only consulted by the GAS Scorecard Input tab to restrict a
-- locked therapist to their own discipline. null = unrestricted (today's behavior).
-- Run this in Supabase Dashboard → SQL Editor

alter table profiles add column if not exists specialty text check (specialty in ('OT','Speech'));

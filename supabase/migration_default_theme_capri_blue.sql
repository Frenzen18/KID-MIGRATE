-- Migration: client-requested rebrand of the default clinic theme, from the
-- original Sky Blue launch look to Capri Blue / Bondi Blue accents on a plain
-- white page background, with a Bondi Blue landing-page footer. Updates both
-- the column defaults (so a fresh install seeds on the new palette) and the
-- live branding_settings row (id = 1, this is a single-tenant app, see
-- server/routes/settings.js), so the current clinic picks it up immediately
-- without anyone having to open Settings > Branding & Theme.
-- card/text/navbar-bg stay as-is; background_color started as Blizzard Blue
-- and the footer started as dark navy in earlier drafts of this migration,
-- both corrected per client feedback before anyone had run this file, so it
-- only ever reflects the final values below.

alter table branding_settings alter column primary_color set default '#00BFFF';
alter table branding_settings alter column secondary_color set default '#0095B6';
alter table branding_settings alter column background_color set default '#FFFFFF';
alter table branding_settings alter column navbar_hover_color set default '#00BFFF';
alter table branding_settings alter column landing_primary_color set default '#00BFFF';
alter table branding_settings alter column footer_bg_color set default '#0095B6';
alter table branding_settings alter column footer_text_color set default '#FFFFFF';

update branding_settings set
  primary_color = '#00BFFF',
  secondary_color = '#0095B6',
  background_color = '#FFFFFF',
  navbar_hover_color = '#00BFFF',
  landing_primary_color = '#00BFFF',
  footer_bg_color = '#0095B6',
  footer_text_color = '#FFFFFF'
where id = 1;

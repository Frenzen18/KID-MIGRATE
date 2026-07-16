/**
 * Applies branding_settings (colors, font, favicon, clinic name) as CSS
 * custom property overrides on the document root, so the whole app (every
 * page that already consumes these tokens in shared.css) re-themes without
 * per-component changes. Reads the public, unauthenticated endpoint since
 * this runs before login on the landing/login pages too.
 */
const CSS_VAR_MAP = {
  // Dashboard-only (Admin/Staff/Therapist/Parent portals). The landing page
  // used to share these too, it now has its own separate fields below so the
  // two can look completely different, not one look forced onto both.
  primary_color: '--color-primary',
  secondary_color: '--color-teal',
  background_color: '--color-page-bg',
  card_color: '--color-surface',
  navbar_bg_color: '--color-navbar-bg',
  navbar_text_color: '--color-navbar-text',
  navbar_hover_color: '--color-navbar-hover',
  // Public landing page only, not shared with the dashboard above.
  landing_primary_color: '--color-landing-primary',
  landing_navbar_bg_color: '--color-landing-navbar-bg',
  landing_background_color: '--color-landing-background',
  footer_bg_color: '--color-footer-bg',
  footer_text_color: '--color-footer-text'
};
// text_color drives two variables at once: --color-body-text (the <body>
// element itself) and --color-text (data tables, dropdowns, form inputs,
// the more visually significant one). Kept separate from CSS_VAR_MAP since
// it's a 1-to-many mapping.
const TEXT_COLOR_VARS = ['--color-body-text', '--color-text'];
// Each name here must match a family loaded in index.html's Google Fonts link,
// and an entry in Branding.jsx's FONT_OPTIONS, all three stay in sync by hand.
const SERIF_FONTS = new Set(['Merriweather', 'Playfair Display']);
const FONT_STACKS = Object.fromEntries([
  'Inter', 'Poppins', 'DM Sans', 'Karla', 'Roboto', 'Open Sans', 'Lato', 'Montserrat',
  'Nunito', 'Raleway', 'Work Sans', 'Source Sans 3', 'Merriweather', 'Playfair Display',
  'Quicksand', 'Rubik', 'Manrope', 'Outfit', 'Plus Jakarta Sans', 'Space Grotesk',
  'Lexend', 'Urbanist', 'Mulish', 'Baloo 2'
].map(name => [name, `'${name}', ${SERIF_FONTS.has(name) ? 'serif' : 'sans-serif'}`]));

export function applyTheme(data) {
  if (!data) return;
  const root = document.documentElement.style;
  for (const [field, cssVar] of Object.entries(CSS_VAR_MAP)) {
    if (data[field]) root.setProperty(cssVar, data[field]);
  }
  if (data.text_color) for (const cssVar of TEXT_COLOR_VARS) root.setProperty(cssVar, data.text_color);
  if (data.font_family) root.setProperty('--font-family-base', FONT_STACKS[data.font_family] || FONT_STACKS.Inter);

  if (data.clinic_name) document.title = data.clinic_name;

  if (data.favicon_url) {
    let link = document.querySelector("link[rel='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = data.favicon_url;
  }

  // Components that already mounted (e.g. the sidebar logo) fetched branding
  // once on their own mount and won't see a later save on their own, tell
  // them directly so a Save Changes click reflects immediately, no refresh.
  window.dispatchEvent(new CustomEvent('kid:branding', { detail: data }));
}

export async function loadTheme() {
  try {
    const res = await fetch('/api/settings/branding/public');
    if (!res.ok) return null;
    const data = await res.json();
    applyTheme(data);
    return data;
  } catch (e) {
    return null; // theme is cosmetic, never block the app on this failing
  }
}

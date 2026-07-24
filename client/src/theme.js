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
// text_color drives three variables at once: --color-body-text (the <body>
// element itself), --color-text (data tables, dropdowns, form inputs), and
// --color-ink (headings, .section-title, .stat-value). Kept separate from
// CSS_VAR_MAP since it's a 1-to-many mapping. --color-ink used to be a fixed
// #0F172A that no branding field touched, headings stayed dark navy even
// under a dark card/background theme and read as invisible, dark-on-dark.
const TEXT_COLOR_VARS = ['--color-body-text', '--color-text', '--color-ink'];
// Each name here must match a family loaded in index.html's Google Fonts link,
// and an entry in Branding.jsx's FONT_OPTIONS, all three stay in sync by hand.
// Darkened hover/active shade of a theme color, computed live instead of a
// second fixed field admins would have to pick separately. Without this,
// --color-primary-dark/--color-teal-dark stayed hardcoded to shared.css's own
// navy default forever, every theme's hover/active states quietly showed that
// unrelated fixed navy instead of a real darker version of the theme's own
// color, one visible reason a picked color read as flat, no tonal depth.
function darken(hex, amount) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  const l2 = Math.max(0, l - amount / 100);
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l2, 1 - l2);
  const f = n => l2 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
}
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
  if (data.primary_color) root.setProperty('--color-primary-dark', darken(data.primary_color, 16));
  if (data.secondary_color) root.setProperty('--color-teal-dark', darken(data.secondary_color, 12));
  if (data.text_color) for (const cssVar of TEXT_COLOR_VARS) root.setProperty(cssVar, data.text_color);
  if (data.font_family) root.setProperty('--font-family-base', FONT_STACKS[data.font_family] || FONT_STACKS.Inter);
  // Every existing font-size in the app is a hardcoded px value tuned against a
  // 16px baseline, so "adjustable text size" is a uniform zoom scale off that
  // baseline rather than a rem rewrite of every component (see --ui-zoom in shared.css).
  if (data.font_size) root.setProperty('--ui-zoom', String(Number(data.font_size) / 16));

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

/**
 * Live-preview support: the Branding & Theme admin tab loads this same site
 * in an iframe and postMessages its unsaved draft here so the preview
 * reflects every edit (colors, logo, clinic name, font, ...) instantly,
 * without saving anything to the database. Only the Branding page's own
 * iframe ever sends this, gated by origin so no other page can push a theme.
 */
export function listenForBrandingPreview() {
  window.addEventListener('message', e => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type !== 'kid:preview-branding') return;
    applyTheme(e.data.data);
  });
}

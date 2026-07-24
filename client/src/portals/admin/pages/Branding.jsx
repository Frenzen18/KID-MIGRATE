import { useState, useEffect, useRef } from 'react';
import { api, getToken } from '../../../api.js';
import { applyTheme } from '../../../theme.js';
import ColorSwatchPicker from '../../../components/ColorSwatchPicker.jsx';

/* == page: branding-theme == */

const BLANK = {
  clinic_name: '', address: '', logo_url: '', favicon_url: '', login_bg_url: '',
  primary_color: '#00BFFF', secondary_color: '#0095B6',
  background_color: '#FFFFFF', card_color: '#FFFFFF', text_color: '#0F172A',
  navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#00BFFF',
  landing_primary_color: '#00BFFF', landing_navbar_bg_color: '#FDFCFA', landing_background_color: '#FDFCFA',
  footer_bg_color: '#0095B6', footer_text_color: '#FFFFFF', font_family: 'Inter', font_size: 18
};
// Same palette the database seeds a fresh clinic with (migration_branding_theme_full.sql
// + migration_landing_page_colors.sql + migration_default_theme_capri_blue.sql).
// "Reset to Default" restores exactly these, it never touches logo/favicon/login
// image/clinic name. Client-requested rebrand: Capri Blue / Bondi Blue accents on
// a plain white page background, replacing the original Sky Blue launch default.
const DEFAULT_THEME = {
  primary_color: '#00BFFF', secondary_color: '#0095B6',
  background_color: '#FFFFFF', card_color: '#FFFFFF', text_color: '#0F172A',
  navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#00BFFF',
  landing_primary_color: '#00BFFF', landing_navbar_bg_color: '#FDFCFA', landing_background_color: '#FDFCFA',
  footer_bg_color: '#0095B6', footer_text_color: '#FFFFFF', font_family: 'Inter', font_size: 18
};
// Phone-style "pick a theme" presets: a full coordinated palette (+ font) applied
// in one click, same live-preview-then-Save flow as every other field on this page,
// nothing here is a separate save path. Each preset's `colors` keys are a subset of
// BLANK/DEFAULT_THEME's fields, spread onto draft so logo/clinic name/font_size are
// left untouched, same contract resetToDefault already follows.
const THEME_PRESETS = [
  {
    key: 'sky', name: 'Capri Blue', description: 'The default clinic look, Capri & Bondi blue on white',
    colors: {
      primary_color: '#00BFFF', secondary_color: '#0095B6',
      background_color: '#FFFFFF', card_color: '#FFFFFF', text_color: '#0F172A',
      navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#00BFFF',
      landing_primary_color: '#00BFFF', landing_navbar_bg_color: '#FDFCFA', landing_background_color: '#FDFCFA',
      footer_bg_color: '#0095B6', footer_text_color: '#FFFFFF', font_family: 'Inter'
    }
  },
  {
    key: 'emerald', name: 'Emerald Forest', description: 'Fresh green, a natural, grounded feel',
    colors: {
      primary_color: '#059669', secondary_color: '#0D9488',
      background_color: '#ECFDF5', card_color: '#FFFFFF', text_color: '#0F172A',
      navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#059669',
      landing_primary_color: '#047857', landing_navbar_bg_color: '#FDFCFA', landing_background_color: '#FDFCFA',
      footer_bg_color: '#052E23', footer_text_color: '#A7F3D0', font_family: 'Nunito'
    }
  },
  {
    key: 'sunset', name: 'Sunset Coral', description: 'Warm orange and rose, energetic and friendly',
    colors: {
      primary_color: '#F97316', secondary_color: '#FB7185',
      background_color: '#FFF7ED', card_color: '#FFFFFF', text_color: '#292524',
      navbar_bg_color: '#FFFFFF', navbar_text_color: '#57534E', navbar_hover_color: '#F97316',
      landing_primary_color: '#EA580C', landing_navbar_bg_color: '#FFFBF5', landing_background_color: '#FFFBF5',
      footer_bg_color: '#431407', footer_text_color: '#FED7AA', font_family: 'Poppins'
    }
  },
  {
    key: 'violet', name: 'Royal Violet', description: 'Rich purple and indigo, a premium feel',
    colors: {
      primary_color: '#7C3AED', secondary_color: '#6366F1',
      background_color: '#F5F3FF', card_color: '#FFFFFF', text_color: '#0F172A',
      navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#7C3AED',
      landing_primary_color: '#6D28D9', landing_navbar_bg_color: '#FDFCFF', landing_background_color: '#FDFCFF',
      footer_bg_color: '#1E1B4B', footer_text_color: '#DDD6FE', font_family: 'Manrope'
    }
  },
  {
    key: 'midnight', name: 'Midnight Dark', description: 'A dark sidebar with a bright accent, dashboard content stays light for guaranteed readability',
    colors: {
      primary_color: '#0284C7', secondary_color: '#0D9488',
      // Many headings/labels across the app set their color as a fixed dark
      // hex directly in inline styles rather than through a theme variable,
      // so they never actually change with any preset. A dark background_color
      // or card_color would put that always-dark text on an equally dark card,
      // reading as invisible. Every preset (this one included) keeps the
      // dashboard content area light for that reason; the sidebar below is
      // fully theme-driven (no hardcoded colors) and safe to invert.
      background_color: '#F1F5F9', card_color: '#FFFFFF', text_color: '#0F172A',
      navbar_bg_color: '#0F172A', navbar_text_color: '#CBD5E1', navbar_hover_color: '#38BDF8',
      landing_primary_color: '#0284C7', landing_navbar_bg_color: '#FDFCFA', landing_background_color: '#FDFCFA',
      footer_bg_color: '#020617', footer_text_color: '#94A3B8', font_family: 'Space Grotesk'
    }
  },
  {
    key: 'rose', name: 'Rose Blush', description: 'Soft pink, a gentle, pediatric-friendly feel',
    colors: {
      primary_color: '#EC4899', secondary_color: '#F472B6',
      background_color: '#FDF2F8', card_color: '#FFFFFF', text_color: '#0F172A',
      navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#EC4899',
      landing_primary_color: '#DB2777', landing_navbar_bg_color: '#FFFBFC', landing_background_color: '#FFFBFC',
      footer_bg_color: '#500724', footer_text_color: '#FBCFE8', font_family: 'Quicksand'
    }
  }
];
const FONT_OPTIONS = [
  'Inter', 'Poppins', 'DM Sans', 'Karla', 'Roboto', 'Open Sans', 'Lato', 'Montserrat',
  'Nunito', 'Raleway', 'Work Sans', 'Source Sans 3', 'Merriweather', 'Playfair Display',
  'Quicksand', 'Rubik', 'Manrope', 'Outfit', 'Plus Jakarta Sans', 'Space Grotesk',
  'Lexend', 'Urbanist', 'Mulish', 'Baloo 2'
];
// Word-style point sizes, scaled site-wide off the 16px baseline every
// component's font-size was already tuned against (see --ui-zoom in shared.css).
const FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24];

// Every hint names the exact element(s) this field repaints, nothing vaguer
// than that, so there's never a question of "where does this show up". All
// five groups render together, stacked, under the single "Colors" sub-tab
// (see BRANDING_TABS below), grouped into cards so related fields still read
// as one unit instead of one flat list of a dozen swatches.
const COLOR_GROUPS = [
  {
    key: 'brand', title: 'Dashboard Brand Colors', icon: 'fa-swatchbook', color: '#0EA5E9',
    fields: [
      { key: 'primary_color', label: 'Primary Color', hint: 'Where: buttons, active sidebar menu item, and input focus outlines in the Admin/Staff/Therapist/Parent portals only, does not affect the public landing page' },
      { key: 'secondary_color', label: 'Secondary Color', hint: 'Where: gradient partner to Primary Color on the same dashboard buttons and the sidebar fallback logo, does not affect the public landing page' }
    ]
  },
  {
    key: 'page', title: 'Dashboard Page Colors', icon: 'fa-file', color: '#64748B',
    fields: [
      { key: 'background_color', label: 'Background Color', hint: 'Where: the browser-window background behind every card, in the Admin/Staff/Therapist/Parent portals only' },
      { key: 'card_color', label: 'Card Color', hint: 'Where: the background of every card, modal, and dropdown, in those same portals' },
      { key: 'text_color', label: 'Text Color', hint: 'Where: default text in data tables, dropdowns, and form inputs, in those same portals' }
    ]
  },
  {
    key: 'navbar', title: 'Dashboard Navbar Colors', icon: 'fa-bars', color: '#0D9488',
    fields: [
      { key: 'navbar_bg_color', label: 'Navbar Background Color', hint: 'Where: the left sidebar background and the top bar above it, in the Admin/Staff/Therapist/Parent portals only' },
      { key: 'navbar_text_color', label: 'Navbar Text Color', hint: 'Where: sidebar menu item labels, normal (not hovered) state' },
      { key: 'navbar_hover_color', label: 'Navbar Hover Color', hint: 'Where: sidebar menu item label color only when hovered' }
    ]
  },
  {
    key: 'landing', title: 'Landing Page Colors', icon: 'fa-globe', color: '#1F4E9E',
    fields: [
      { key: 'landing_primary_color', label: 'Primary Color', hint: 'Where: nav icon and link hover colors, and the hero title emphasis word, on the public landing page (/) only, independent from the Dashboard Primary Color above' },
      { key: 'landing_navbar_bg_color', label: 'Top Nav Background Color', hint: 'Where: the landing page\'s own fixed top nav bar background, independent from Dashboard Navbar Background Color' },
      { key: 'landing_background_color', label: 'Page Background Color', hint: 'Where: the landing page\'s overall background and hero section, independent from Dashboard Background Color' }
    ]
  },
  {
    key: 'footer', title: 'Landing Page Footer Colors', icon: 'fa-shoe-prints', color: '#0095B6',
    fields: [
      { key: 'footer_bg_color', label: 'Footer Background Color', hint: 'Where: the footer bar at the bottom of the public landing page (/) only' },
      { key: 'footer_text_color', label: 'Footer Text Color', hint: 'Where: just the clinic name heading in that footer; nav links and the copyright line keep a fixed light color for contrast' }
    ]
  }
];
const IMAGE_FIELDS = [
  { key: 'logo_url', label: 'Logo', hint: 'Where: sidebar top-left (every portal), landing page nav bar, and printable invoice letterhead · PNG/GIF/WEBP · Max 2MB · Recommended 256×256' },
  { key: 'favicon_url', label: 'Favicon', hint: 'Where: the browser tab icon · PNG · Max 1MB · Recommended 64×64' },
  { key: 'login_bg_url', label: 'Login Background Image', hint: 'Where: background photo behind the left panel on Login, Signup, Verify Email, Set Password, and Forgot Password screens' }
];
// Sub-tabs shown under Branding & Theme, in display order.
const BRANDING_TABS = [
  { key: 'presets', label: 'Theme Presets', icon: 'fa-palette' },
  { key: 'identity', label: 'Clinic Identity', icon: 'fa-hospital' },
  { key: 'images', label: 'Logo & Images', icon: 'fa-images' },
  { key: 'colors', label: 'Colors', icon: 'fa-swatchbook' },
  { key: 'typography', label: 'Typography', icon: 'fa-font' }
];
const BRANDING_TAB_KEYS = BRANDING_TABS.map(t => t.key);

export default function Branding({ toast, embedded = false, onDirtyChange }) {
  // Searchable font picker: types to filter FONT_OPTIONS instead of scrolling
  // one long native <select>. Stays synced to draft.font_family whenever the
  // dropdown isn't open (load, Reset to Default, Discard), so it never shows
  // stale text; while open, typing is left alone until a font is picked.
  const [fontSearch, setFontSearch] = useState('');
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);

  const [subtab, setSubtab] = useState(() => {
    // One-shot: Settings' "Edit in CMS" buttons (Clinic Name, Address) point
    // straight at this sub-tab, takes priority over whatever was last open.
    const requested = sessionStorage.getItem('cms_branding_initial_subtab');
    if (requested) { sessionStorage.removeItem('cms_branding_initial_subtab'); return requested; }
    const saved = localStorage.getItem('kid_admin_branding_subtab');
    return BRANDING_TAB_KEYS.includes(saved) ? saved : 'presets';
  });
  useEffect(() => { localStorage.setItem('kid_admin_branding_subtab', subtab); }, [subtab]);

  const [saved, setSaved] = useState(BLANK);
  const [draft, setDraft] = useState(BLANK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState(null);
  const [previewKey, setPreviewKey] = useState(0);
  const fileInputs = { logo_url: useRef(null), favicon_url: useRef(null), hero_banner_url: useRef(null), login_bg_url: useRef(null) };
  const previewIframeRef = useRef(null);

  const fetchBranding = () => {
    setLoading(true);
    api('/settings/branding')
      .then(data => { setSaved({ ...BLANK, ...data }); setDraft({ ...BLANK, ...data }); })
      .catch(() => toast('Failed to load branding settings', 'fa-triangle-exclamation'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchBranding(); }, []);

  const setField = (k, v) => setDraft(prev => ({ ...prev, [k]: v }));

  useEffect(() => { if (!fontDropdownOpen) setFontSearch(draft.font_family || ''); }, [draft.font_family, fontDropdownOpen]);
  const fontMatches = FONT_OPTIONS.filter(f => f.toLowerCase().includes(fontSearch.trim().toLowerCase()));
  function pickFont(f) {
    setField('font_family', f);
    setFontSearch(f);
    setFontDropdownOpen(false);
  }

  async function save() {
    if (JSON.stringify(saved) === JSON.stringify(draft)) {
      toast('No changes to save', 'fa-circle-exclamation');
      return;
    }
    setSaving(true);
    try {
      const result = await api('/settings/branding', { method: 'PUT', body: draft });
      setSaved({ ...BLANK, ...result });
      setDraft({ ...BLANK, ...result });
      applyTheme(result); // reflect immediately, everywhere, no refresh needed, only happens on Save
      setPreviewKey(k => k + 1); // reload the live-site preview iframe so it shows the just-saved change
      toast('Branding & theme saved, applied site-wide', 'fa-check');
    } catch (err) {
      toast(err.message || 'Failed to save branding settings', 'fa-circle-exclamation');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(saved);
    toast('Changes discarded', 'fa-rotate-left');
  }

  function resetToDefault() {
    setDraft(prev => ({ ...prev, ...DEFAULT_THEME }));
    // Previews live immediately (same as any other color edit), but nothing is
    // saved to the database yet, make that explicit here since resetting every
    // color/font at once is a bigger visual jump than a single field edit.
    toast('Previewing default colors & font live, not saved yet, click Save Changes to keep them or Discard Changes to undo', 'fa-rotate-left');
  }

  function applyPreset(preset) {
    setDraft(prev => ({ ...prev, ...preset.colors }));
    toast(`Previewing "${preset.name}" theme live, not saved yet, click Save Changes to keep it or Discard Changes to undo`, 'fa-palette');
  }
  function isPresetActive(preset) {
    return Object.entries(preset.colors).every(([k, v]) => draft[k] === v);
  }

  async function handleUpload(field, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please select an image file', 'fa-circle-exclamation'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('Image must be under 5MB', 'fa-circle-exclamation'); return; }
    setUploadingField(field);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/cms/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setField(field, data.url);
      toast('Image uploaded, click Save Changes to apply', 'fa-check');
    } catch (err) {
      toast('Upload failed: ' + err.message, 'fa-circle-exclamation');
    } finally {
      setUploadingField(null);
      e.target.value = '';
    }
  }

  const isDirty = JSON.stringify(saved) !== JSON.stringify(draft);

  // Tell AdminPortal whether there's something to lose, it warns before letting you
  // navigate to a different module (Dashboard, Client Records, ...) while dirty, the
  // same protection beforeunload below gives against an actual reload/close.
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty]);

  // Live preview: push every draft edit into the preview iframe so it shows the
  // change immediately, no Save needed. postMessage instead of just re-pointing
  // src, so nothing is ever written to the database until Save Changes. Guarded
  // on `loading`: draft starts as BLANK's placeholder colors before the real fetch
  // resolves, posting those first would flash the wrong theme for a moment, same
  // bug class as the CSS-default-vs-DB-value flash fixed earlier.
  function postDraftToPreview() {
    if (loading) return;
    previewIframeRef.current?.contentWindow?.postMessage({ type: 'kid:preview-branding', data: draft }, window.location.origin);
  }
  useEffect(() => { postDraftToPreview(); }, [draft, loading]);

  // Live-reskin the admin app itself too, not just the iframe, Dashboard Brand/Page/Navbar
  // Colors have no representation in the landing-page preview at all (that's a different,
  // independent palette), the sidebar/buttons you're looking at right now ARE the preview
  // for those fields. Same applyTheme() Save already used, just fired on every edit instead
  // of only after Save. Nothing is persisted here, still local to this browser tab.
  useEffect(() => { if (!loading) applyTheme(draft); }, [draft, loading]);

  // If you navigate away from CMS (not just switch its own tabs, which leaves this
  // component mounted) with unsaved edits, put the real saved theme back rather than
  // leaving the tried-on draft applied to the rest of the app with no way back to it.
  const savedRef = useRef(saved);
  useEffect(() => { savedRef.current = saved; }, [saved]);
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  useEffect(() => () => { if (!loadingRef.current) applyTheme(savedRef.current); }, []);

  // Warn on an actual browser reload/close with unsaved changes, there's no
  // way to lose them silently otherwise (switching CMS's own tabs is safe,
  // this component stays mounted in the background either way).
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  function openPreviewWindow() {
    window.open('/?preview=1', 'kidBrandingPreview', 'width=1280,height=900,noopener,noreferrer');
  }

  const body = (
    <>
      <div style={{
        position: 'sticky', top: 64, zIndex: 30, background: 'var(--color-page-bg)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        padding: '14px 0', marginBottom: 10, borderBottom: '1px solid #E2E8F0'
      }}>
        {!embedded && (
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Branding &amp; Theme</h1>
            <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Colors, logo, and fonts, loaded dynamically and applied across the whole system.</p>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          <button className="btn-secondary" disabled={saving || loading} onClick={resetToDefault} title="Resets colors & font only, not logo or clinic name"><i className="fa-solid fa-rotate-left" style={{ marginRight: 6 }} />Reset to Default</button>
          <button className="btn-secondary" disabled={saving || loading || !isDirty} onClick={discard}>Discard Changes</button>
          <button className="btn-primary" disabled={saving || loading} onClick={save}>
            <i className={'fa-solid ' + (saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 6 }} />{saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Sub-tabs, one section visible at a time instead of one long scroll */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {BRANDING_TABS.map(t => (
          <button key={t.key} className={'cms-tab-btn' + (subtab === t.key ? ' active' : '')} onClick={() => setSubtab(t.key)}>
            <i className={'fa-solid ' + t.icon} style={{ marginRight: 6 }} />{t.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 520px', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          {/* Theme Presets: a full coordinated palette + font applied in one click,
             the phone-style "pick a theme" entry point into everything below. */}
          {subtab === 'presets' && (
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-palette" style={{ color: '#EC4899', marginRight: 6 }} />Theme Presets</div>
              <div className="section-sub" style={{ marginBottom: 18 }}>Pick a complete theme, colors, navbar, footer, and font all applied together. Preview updates instantly below, click Save Changes to keep it.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 14 }}>
                {THEME_PRESETS.map(preset => {
                  const active = isPresetActive(preset);
                  return (
                    <div
                      key={preset.key}
                      onClick={() => !loading && applyPreset(preset)}
                      style={{
                        cursor: loading ? 'default' : 'pointer', padding: 14, borderRadius: 14,
                        border: active ? `2px solid ${preset.colors.primary_color}` : '1px solid #E2E8F0',
                        background: '#fff', transition: 'transform .15s ease, box-shadow .15s ease', position: 'relative'
                      }}
                      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 18px rgba(15,23,42,.08)'; }}
                      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                    >
                      {active && (
                        <div style={{ position: 'absolute', top: 10, right: 10, width: 22, height: 22, borderRadius: '50%', background: preset.colors.primary_color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>
                          <i className="fa-solid fa-check" />
                        </div>
                      )}
                      <div style={{ display: 'flex', height: 66, borderRadius: 10, overflow: 'hidden', border: '1px solid #E2E8F0', marginBottom: 12 }}>
                        <div style={{ width: 18, background: preset.colors.navbar_bg_color, borderRight: '1px solid rgba(0,0,0,.06)' }} />
                        <div style={{ flex: 1, background: preset.colors.background_color, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ width: '55%', height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${preset.colors.primary_color}, ${preset.colors.secondary_color})` }} />
                          <div style={{ flex: 1, background: preset.colors.card_color, borderRadius: 6 }} />
                        </div>
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 13.5, color: '#0F172A' }}>{preset.name}</div>
                      <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>{preset.description}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Clinic Identity, the name shown site-wide: sidebar, landing page, invoices, login screens */}
          {subtab === 'identity' && (
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-hospital" style={{ color: '#0EA5E9', marginRight: 6 }} />Clinic Identity</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label className="form-label">Clinic Name</label>
                  <input type="text" className="form-input" value={draft.clinic_name} onChange={e => setField('clinic_name', e.target.value)} disabled={loading} placeholder="e.g. Bloomsdale Therapy Center" />
                  <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>Where: sidebar logo text (every portal), landing page nav bar + hero + footer, login/signup screens, and printable invoice letterhead</div>
                </div>
                <div>
                  <label className="form-label">Address</label>
                  <input type="text" className="form-input" value={draft.address} onChange={e => setField('address', e.target.value)} disabled={loading} placeholder="e.g. 123 Therapy Lane, Quezon City, Metro Manila 1100" />
                  <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>Where: landing page hero kicker ("Clinic Name · Address") and footer, and the Login/Signup left panel footer, in every portal</div>
                </div>
              </div>
            </div>
          )}

          {/* Images */}
          {subtab === 'images' && (
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-images" style={{ color: '#0D9488', marginRight: 6 }} />Logo &amp; Images</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {IMAGE_FIELDS.map(f => (
                  <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 14, border: '1px dashed #E2E8F0', borderRadius: 12, background: '#F8FAFC' }}>
                    {draft[f.key]
                      ? <img src={draft[f.key]} alt={f.label} style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
                      : <div style={{ width: 48, height: 48, borderRadius: 10, background: '#E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><i className="fa-solid fa-image" style={{ color: '#94A3B8' }} /></div>}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: '#0F172A', fontSize: 13 }}>{f.label}</div>
                      <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 1, marginBottom: 6 }}>{f.hint}</div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-edit" style={{ fontSize: 11 }} disabled={uploadingField === f.key} onClick={() => fileInputs[f.key].current?.click()}>
                          <i className={'fa-solid ' + (uploadingField === f.key ? 'fa-spinner fa-spin' : 'fa-upload')} /> {uploadingField === f.key ? 'Uploading…' : draft[f.key] ? 'Replace' : 'Upload'}
                        </button>
                        {draft[f.key] && (
                          <button className="btn-edit" style={{ fontSize: 11, color: '#DC2626' }} title="Remove, reverts to the default" onClick={() => setField(f.key, '')}>
                            <i className="fa-solid fa-trash" />
                          </button>
                        )}
                      </div>
                      <input ref={fileInputs[f.key]} type="file" accept="image/*" onChange={e => handleUpload(f.key, e)} style={{ display: 'none' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Colors, all five groups stacked together in one sub-tab, still grouped
             into their own cards so related fields (brand/page/navbar/landing/footer)
             read as separate units instead of one flat list of a dozen swatches. */}
          {subtab === 'colors' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {COLOR_GROUPS.map(group => (
                <div className="card" key={group.title} style={{ padding: '22px 20px' }}>
                  <div className="section-title" style={{ marginBottom: 16 }}><i className={'fa-solid ' + group.icon} style={{ color: group.color, marginRight: 6 }} />{group.title}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    {group.fields.map(f => (
                      <div key={f.key}>
                        <label className="form-label">{f.label}</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <ColorSwatchPicker value={draft[f.key]} onChange={v => setField(f.key, v)} disabled={loading} />
                          <input type="text" className="form-input" value={draft[f.key]} onChange={e => setField(f.key, e.target.value)} style={{ flex: 1 }} disabled={loading} />
                        </div>
                        <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>{f.hint}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Typography */}
          {subtab === 'typography' && (
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-font" style={{ color: '#818CF8', marginRight: 6 }} />Typography</div>
              <label className="form-label">Font Family</label>
              <div style={{ position: 'relative', maxWidth: 260 }}>
                <input
                  className="form-input"
                  autoComplete="off"
                  placeholder="Type to search fonts…"
                  value={fontSearch}
                  disabled={loading}
                  onChange={e => { setFontSearch(e.target.value); setFontDropdownOpen(true); }}
                  onFocus={() => setFontDropdownOpen(true)}
                  onBlur={() => setFontDropdownOpen(false)}
                />
                {fontDropdownOpen && (
                  <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, maxHeight: 240, overflowY: 'auto', background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, boxShadow: '0 8px 20px rgba(15,23,42,.1)' }}>
                    {fontMatches.length ? fontMatches.map(f => (
                      <div
                        key={f}
                        // onMouseDown (not onClick) fires before the input's onBlur closes the dropdown.
                        onMouseDown={e => { e.preventDefault(); pickFont(f); }}
                        style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #F1F5F9', fontWeight: f === draft.font_family ? 700 : 400, color: f === draft.font_family ? '#0EA5E9' : '#0F172A' }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#F0F9FF'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                      >
                        {f}
                      </div>
                    )) : (
                      <div style={{ padding: '8px 12px', fontSize: 12.5, color: '#94A3B8' }}>No matching fonts</div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>Where: body/paragraph text, site-wide · headings stay Poppins regardless of this setting</div>

              <label className="form-label" style={{ marginTop: 20, display: 'block' }}>Text Size</label>
              <select
                className="form-select"
                style={{ maxWidth: 260 }}
                disabled={loading}
                value={draft.font_size || 18}
                onChange={e => setField('font_size', Number(e.target.value))}
              >
                {FONT_SIZE_OPTIONS.map(sz => (
                  <option key={sz} value={sz}>{sz}{sz === 18 ? ' (Default)' : ''}</option>
                ))}
              </select>
              <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>Where: base text size, applied everywhere, every portal and the public site, scaled proportionally from this baseline</div>
            </div>
          )}
        </div>

        {/* Live preview, sticky so it stays in view while you scroll the form, the real landing page (not a mock). Reflects every unsaved edit instantly via postMessage (see postDraftToPreview above); Save Changes just makes it permanent. */}
        <div className="browser-frame" style={{ position: 'sticky', top: 20 }}>
          <div className="browser-bar">
            <span className="b-dot" style={{ background: '#FCA5A5' }} /><span className="b-dot" style={{ background: '#FDE68A' }} /><span className="b-dot" style={{ background: '#86EFAC' }} />
            <span className="browser-url">Live Preview</span>
          </div>
          <iframe
            ref={previewIframeRef}
            key={previewKey}
            src="/?preview=1"
            title="Live site preview"
            onLoad={postDraftToPreview}
            style={{ width: '100%', height: 560, border: 'none', display: 'block', background: '#fff' }}
          />
          <div style={{ padding: '10px 14px', borderTop: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#F8FAFC' }}>
            <span style={{ fontSize: 11, color: '#64748B' }}>{isDirty ? 'Showing unsaved changes, click Save to keep them' : 'Up to date'}</span>
            <button className="btn-edit" style={{ fontSize: 11 }} onClick={openPreviewWindow}>
              <i className="fa-solid fa-up-right-from-square" style={{ marginRight: 5 }} />Open in New Window
            </button>
          </div>
        </div>
      </div>

      {!embedded && <div className="page-footer" style={{ marginTop: 24 }}><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System</span></div>}
    </>
  );

  if (embedded) return body;
  return <div className="spa-page" id="spa-branding">{body}</div>;
}

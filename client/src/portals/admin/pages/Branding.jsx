import { useState, useEffect, useRef } from 'react';
import { api, getToken } from '../../../api.js';
import { applyTheme } from '../../../theme.js';

/* == page: branding-theme == */

const BLANK = {
  clinic_name: '', logo_url: '', favicon_url: '', login_bg_url: '',
  primary_color: '#0EA5E9', secondary_color: '#0D9488',
  background_color: '#F0F6FF', card_color: '#FFFFFF', text_color: '#0F172A',
  navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#0EA5E9',
  landing_primary_color: '#1F4E9E', landing_navbar_bg_color: '#FDFCFA', landing_background_color: '#FDFCFA',
  footer_bg_color: '#182238', footer_text_color: '#CBD5E1', font_family: 'Inter'
};
// Same palette the database seeds a fresh clinic with (migration_branding_theme_full.sql
// + migration_landing_page_colors.sql). "Reset to Default" restores exactly these, it
// never touches logo/favicon/login image/clinic name.
const DEFAULT_THEME = {
  primary_color: '#0EA5E9', secondary_color: '#0D9488',
  background_color: '#F0F6FF', card_color: '#FFFFFF', text_color: '#0F172A',
  navbar_bg_color: '#FFFFFF', navbar_text_color: '#475569', navbar_hover_color: '#0EA5E9',
  landing_primary_color: '#1F4E9E', landing_navbar_bg_color: '#FDFCFA', landing_background_color: '#FDFCFA',
  footer_bg_color: '#182238', footer_text_color: '#CBD5E1', font_family: 'Inter'
};
const FONT_OPTIONS = [
  'Inter', 'Poppins', 'DM Sans', 'Karla', 'Roboto', 'Open Sans', 'Lato', 'Montserrat',
  'Nunito', 'Raleway', 'Work Sans', 'Source Sans 3', 'Merriweather', 'Playfair Display',
  'Quicksand', 'Rubik', 'Manrope', 'Outfit', 'Plus Jakarta Sans', 'Space Grotesk',
  'Lexend', 'Urbanist', 'Mulish', 'Baloo 2'
];

// Every hint names the exact element(s) this field repaints, nothing vaguer
// than that, so there's never a question of "where does this show up".
const COLOR_GROUPS = [
  {
    title: 'Dashboard Brand Colors', icon: 'fa-swatchbook', color: '#0EA5E9',
    fields: [
      { key: 'primary_color', label: 'Primary Color', hint: 'Where: buttons, active sidebar menu item, and input focus outlines in the Admin/Staff/Therapist/Parent portals only, does not affect the public landing page' },
      { key: 'secondary_color', label: 'Secondary Color', hint: 'Where: gradient partner to Primary Color on the same dashboard buttons and the sidebar fallback logo, does not affect the public landing page' }
    ]
  },
  {
    title: 'Dashboard Page Colors', icon: 'fa-file', color: '#64748B',
    fields: [
      { key: 'background_color', label: 'Background Color', hint: 'Where: the browser-window background behind every card, in the Admin/Staff/Therapist/Parent portals only' },
      { key: 'card_color', label: 'Card Color', hint: 'Where: the background of every card, modal, and dropdown, in those same portals' },
      { key: 'text_color', label: 'Text Color', hint: 'Where: default text in data tables, dropdowns, and form inputs, in those same portals' }
    ]
  },
  {
    title: 'Dashboard Navbar Colors', icon: 'fa-bars', color: '#0D9488',
    fields: [
      { key: 'navbar_bg_color', label: 'Navbar Background Color', hint: 'Where: the left sidebar background and the top bar above it, in the Admin/Staff/Therapist/Parent portals only' },
      { key: 'navbar_text_color', label: 'Navbar Text Color', hint: 'Where: sidebar menu item labels, normal (not hovered) state' },
      { key: 'navbar_hover_color', label: 'Navbar Hover Color', hint: 'Where: sidebar menu item label color only when hovered' }
    ]
  },
  {
    title: 'Landing Page Colors', icon: 'fa-globe', color: '#1F4E9E',
    fields: [
      { key: 'landing_primary_color', label: 'Primary Color', hint: 'Where: nav icon and link hover colors, and the hero title emphasis word, on the public landing page (/) only, independent from the Dashboard Primary Color above' },
      { key: 'landing_navbar_bg_color', label: 'Top Nav Background Color', hint: 'Where: the landing page\'s own fixed top nav bar background, independent from Dashboard Navbar Background Color' },
      { key: 'landing_background_color', label: 'Page Background Color', hint: 'Where: the landing page\'s overall background and hero section, independent from Dashboard Background Color' }
    ]
  },
  {
    title: 'Landing Page Footer Colors', icon: 'fa-shoe-prints', color: '#182238',
    fields: [
      { key: 'footer_bg_color', label: 'Footer Background Color', hint: 'Where: the dark footer bar at the bottom of the public landing page (/) only' },
      { key: 'footer_text_color', label: 'Footer Text Color', hint: 'Where: just the clinic name heading in that footer; nav links and the copyright line keep a fixed light color for contrast' }
    ]
  }
];
const IMAGE_FIELDS = [
  { key: 'logo_url', label: 'Logo', hint: 'Where: sidebar top-left (every portal), landing page nav bar, and printable invoice letterhead · PNG/GIF/WEBP · Max 2MB · Recommended 256×256' },
  { key: 'favicon_url', label: 'Favicon', hint: 'Where: the browser tab icon · PNG · Max 1MB · Recommended 64×64' },
  { key: 'login_bg_url', label: 'Login Background Image', hint: 'Where: background photo behind the left panel on Login, Signup, Verify Email, Set Password, and Forgot Password screens' }
];

export default function Branding({ toast, embedded = false }) {
  const [saved, setSaved] = useState(BLANK);
  const [draft, setDraft] = useState(BLANK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState(null);
  const [previewKey, setPreviewKey] = useState(0);
  const fileInputs = { logo_url: useRef(null), favicon_url: useRef(null), hero_banner_url: useRef(null), login_bg_url: useRef(null) };

  const fetchBranding = () => {
    setLoading(true);
    api('/settings/branding')
      .then(data => { setSaved({ ...BLANK, ...data }); setDraft({ ...BLANK, ...data }); })
      .catch(() => toast('Failed to load branding settings', 'fa-triangle-exclamation'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchBranding(); }, []);

  const setField = (k, v) => setDraft(prev => ({ ...prev, [k]: v }));

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
    toast('Colors & font reset to default, click Save Changes to apply', 'fa-rotate-left');
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

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 520px', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {/* Clinic Identity, the name shown site-wide: sidebar, landing page, invoices, login screens */}
          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-hospital" style={{ color: '#0EA5E9', marginRight: 6 }} />Clinic Identity</div>
            <label className="form-label">Clinic Name</label>
            <input type="text" className="form-input" value={draft.clinic_name} onChange={e => setField('clinic_name', e.target.value)} disabled={loading} placeholder="e.g. Bloomsdale Therapy Center" />
            <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>Where: sidebar logo text (every portal), landing page nav bar + hero + footer, login/signup screens, and printable invoice letterhead</div>
          </div>

          {/* Images */}
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

          {/* Colors, grouped by exactly what each one controls */}
          {COLOR_GROUPS.map(group => (
            <div className="card" key={group.title} style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 16 }}><i className={'fa-solid ' + group.icon} style={{ color: group.color, marginRight: 6 }} />{group.title}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {group.fields.map(f => (
                  <div key={f.key}>
                    <label className="form-label">{f.label}</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input type="color" value={draft[f.key]} onChange={e => setField(f.key, e.target.value)} style={{ width: 40, height: 38, border: 'none', borderRadius: 8, cursor: 'pointer' }} disabled={loading} />
                      <input type="text" className="form-input" value={draft[f.key]} onChange={e => setField(f.key, e.target.value)} style={{ flex: 1 }} disabled={loading} />
                    </div>
                    <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>{f.hint}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Typography */}
          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-font" style={{ color: '#818CF8', marginRight: 6 }} />Typography</div>
            <label className="form-label">Font Family</label>
            <select className="form-select" value={draft.font_family} onChange={e => setField('font_family', e.target.value)} disabled={loading} style={{ maxWidth: 260 }}>
              {FONT_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>Where: body/paragraph text, site-wide · headings stay Poppins regardless of this setting</div>
          </div>
        </div>

        {/* Live preview, sticky so it stays in view while you scroll the form, the real landing page (not a mock), reloads after Save so it always shows the saved state */}
        <div className="browser-frame" style={{ position: 'sticky', top: 20 }}>
          <div className="browser-bar">
            <span className="b-dot" style={{ background: '#FCA5A5' }} /><span className="b-dot" style={{ background: '#FDE68A' }} /><span className="b-dot" style={{ background: '#86EFAC' }} />
            <span className="browser-url">Live Preview</span>
          </div>
          <iframe
            key={previewKey}
            src="/?preview=1"
            title="Live site preview"
            style={{ width: '100%', height: 560, border: 'none', display: 'block', background: '#fff' }}
          />
          <div style={{ padding: '10px 14px', borderTop: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#F8FAFC' }}>
            <span style={{ fontSize: 11, color: '#64748B' }}>Updates after you Save</span>
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

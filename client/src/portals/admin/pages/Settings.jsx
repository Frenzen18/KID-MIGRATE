import { useState, useEffect } from 'react';
import { api } from '../../../api.js';

/* == page: settings == */

const BLANK_BRANDING = {
  clinic_name: '', address: '', phone: '', email: '', hours_weekdays: '', hours_saturday: '', website_url: ''
};

export default function Settings({ toast, openModal, go }) {
  const [branding, setBranding] = useState(BLANK_BRANDING);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchBranding = () => {
    setLoading(true);
    api('/settings/branding')
      .then(data => setBranding({ ...BLANK_BRANDING, ...data }))
      .catch(() => toast('Failed to load clinic settings', 'fa-triangle-exclamation'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchBranding(); }, []);

  const setField = (k, v) => setBranding(prev => ({ ...prev, [k]: v }));

  async function saveBranding() {
    setSaving(true);
    try {
      const saved = await api('/settings/branding', { method: 'PUT', body: branding });
      setBranding({ ...BLANK_BRANDING, ...saved });
      toast('Settings saved successfully!', 'fa-check');
    } catch (err) {
      toast(err.message || 'Failed to save settings', 'fa-circle-exclamation');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="spa-page" id="spa-settings">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Settings</h1><p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Configure clinic information and system preferences.</p></div>
        <button className="btn-primary" disabled={saving || loading} onClick={saveBranding}><i className={'fa-solid ' + (saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 6 }} />{saving ? 'Saving…' : 'Save Changes'}</button>
      </div>

      <div className="card" style={{ padding: '22px 20px', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-file-pen" style={{ color: '#4F46E5', marginRight: 6 }} />Child Registration Form</div>
            <div className="section-sub">Manage the "Development & Functional Information" section parents fill in when linking a child, add, rename, or remove questions and their answer choices. Changes apply immediately to the linking form and Client Records, clinic-wide.</div>
          </div>
          <button className="btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={() => openModal('manage-dev-functional-fields', {})}>
            <i className="fa-solid fa-sliders" style={{ marginRight: 6 }} />Manage Form Fields
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: '22px 20px', marginBottom: 24 }}>
        <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-hospital" style={{ color: '#0EA5E9', marginRight: 6 }} />Clinic Information</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="form-label">Clinic Name</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0' }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A', flex: 1 }}>{branding.clinic_name || '—'}</span>
              <button className="btn-edit" style={{ fontSize: 11, whiteSpace: 'nowrap' }} onClick={() => { sessionStorage.setItem('cms_initial_tab', 'branding'); go('cms'); }}>Edit in CMS</button>
            </div>
          </div>
          <div><label className="form-label">Address</label><input type="text" className="form-input" value={branding.address} onChange={e => setField('address', e.target.value)} disabled={loading} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label className="form-label">Phone</label><input type="tel" className="form-input" value={branding.phone} onChange={e => setField('phone', e.target.value)} disabled={loading} /></div>
            <div><label className="form-label">Email</label><input type="email" className="form-input" value={branding.email} onChange={e => setField('email', e.target.value)} disabled={loading} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label className="form-label">Operating Hours (Weekdays)</label><input type="text" className="form-input" value={branding.hours_weekdays} onChange={e => setField('hours_weekdays', e.target.value)} disabled={loading} /></div>
            <div><label className="form-label">Operating Hours (Saturday)</label><input type="text" className="form-input" value={branding.hours_saturday} onChange={e => setField('hours_saturday', e.target.value)} disabled={loading} /></div>
          </div>
          <div><label className="form-label">Website URL</label><input type="url" className="form-input" value={branding.website_url} onChange={e => setField('website_url', e.target.value)} disabled={loading} /></div>
        </div>
      </div>

      <div className="card" style={{ padding: '22px 20px', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-palette" style={{ color: '#0D9488', marginRight: 6 }} />Branding &amp; Theme</div>
            <div className="section-sub">Logo, favicon, colors, fonts, and login background are managed on the CMS's Branding &amp; Theme tab.</div>
          </div>
          <button className="btn-edit" style={{ whiteSpace: 'nowrap' }} onClick={() => { sessionStorage.setItem('cms_initial_tab', 'branding'); go('cms'); }}>
            <i className="fa-solid fa-arrow-right" style={{ marginRight: 6 }} />Open in CMS
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: '22px 20px', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-bell" style={{ color: '#F59E0B', marginRight: 6 }} />Notification Preferences</div>
            <div className="section-sub">Which events trigger notifications, and through which channels, is managed on the Notifications page.</div>
          </div>
          <button className="btn-edit" style={{ whiteSpace: 'nowrap' }} onClick={() => go('notifications')}>
            <i className="fa-solid fa-sliders" style={{ marginRight: 6 }} />Manage in Notifications
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" disabled={saving || loading} onClick={() => { fetchBranding(); toast('Changes discarded', 'fa-rotate-left'); }}>Discard Changes</button>
        <button className="btn-primary" disabled={saving || loading} onClick={saveBranding}><i className={'fa-solid ' + (saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 6 }} />{saving ? 'Saving…' : 'Save Changes'}</button>
      </div>
      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System</span></div>
    </div>
  );
}

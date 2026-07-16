import { useState, useEffect } from 'react';

/**
 * Sidebar logo + clinic name, shared by all four portals (admin/staff/
 * therapist/parent). Reads logo_url/clinic_name from Branding & Theme so
 * a saved change there replaces the fallback icon + "KID" everywhere,
 * with no code change needed per clinic.
 */
export default function BrandLogo({ subtitle }) {
  const [logo, setLogo] = useState(null);
  const [name, setName] = useState('KID');

  useEffect(() => {
    fetch('/api/settings/branding/public').then(r => r.json()).then(d => {
      if (d?.logo_url) setLogo(d.logo_url);
      if (d?.clinic_name) setName(d.clinic_name);
    }).catch(() => {});

    // Picks up a Save Changes click on Branding & Theme without needing a
    // refresh, even though this component mounted (and fetched) earlier.
    const onBranding = e => {
      if (e.detail?.logo_url) setLogo(e.detail.logo_url);
      if (e.detail?.clinic_name) setName(e.detail.clinic_name);
    };
    window.addEventListener('kid:branding', onBranding);
    return () => window.removeEventListener('kid:branding', onBranding);
  }, []);

  return (
    <div className="logo-area">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {logo
          ? <img src={logo} alt={name} style={{ width: 38, height: 38, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
          : <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,var(--color-primary),var(--color-teal))', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className="fa-solid fa-child-reaching" style={{ color: '#fff', fontSize: 17 }} />
            </div>}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "'Poppins',sans-serif", fontWeight: 700, fontSize: 16, color: '#0F172A', lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={name}>{name}</div>
          <div style={{ fontSize: 10.5, color: '#64748B', fontWeight: 500 }}>{subtitle}</div>
        </div>
      </div>
    </div>
  );
}

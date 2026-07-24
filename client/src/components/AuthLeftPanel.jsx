import { useState, useEffect } from 'react';

/**
 * The dark left-hand panel (icon ring, "KID" wordmark, eyebrow, clinic
 * name/address footer) shown on every public auth screen: login, signup,
 * verify-email, set-password, forgot-password. Was duplicated identically
 * across 5 files with "Bloomsdale Therapy Center" hardcoded in each, now a
 * single component reading clinic_name/address from Branding & Theme.
 */
export default function AuthLeftPanel({ icon, iconSize = 40, eyebrow }) {
  const [brand, setBrand] = useState(null);

  useEffect(() => {
    fetch('/api/settings/branding/public').then(r => r.json()).then(setBrand).catch(() => {});

    const onBranding = e => { if (e.detail) setBrand(e.detail); };
    window.addEventListener('kid:branding', onBranding);
    return () => window.removeEventListener('kid:branding', onBranding);
  }, []);

  return (
    <div
      className="login-left"
      style={brand?.login_bg_url ? {
        // No color tint over the photo when one's uploaded, the panel's flat
        // Primary Color background (from .login-left in app.css) only shows
        // when there's no photo to fall back to.
        backgroundImage: `url(${brand.login_bg_url})`,
        backgroundSize: 'cover', backgroundPosition: 'center'
      } : undefined}
    >
      <div className="login-icon-ring" style={{ width: 96, height: 96, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {brand?.logo_url
          ? <img src={brand.logo_url} alt={brand.clinic_name || 'Clinic logo'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <i className={'fa-solid ' + icon} style={{ color: '#fff', fontSize: iconSize }} />}
      </div>
      <div style={{ fontFamily: 'Poppins,sans-serif', fontSize: 30, fontWeight: 600, color: '#fff', maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={brand?.clinic_name}>{brand?.clinic_name || 'KID'}</div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,.7)', letterSpacing: '.05em', textTransform: 'uppercase', fontWeight: 600, lineHeight: 1.6 }}>
        {eyebrow}
      </div>
      <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,.5)', lineHeight: 1.7, marginTop: 24 }}>
        {brand?.clinic_name || 'Bloomsdale Therapy Center'}<br />{brand?.address || 'Imus, Cavite'}
      </div>
    </div>
  );
}

/* == page: settings == */

export default function Settings({ toast, openModal }) {
  return (
    <div className="spa-page" id="spa-settings">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div><h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Settings</h1><p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Configure clinic information, branding, notifications, and system preferences.</p></div>
        <button className="btn-primary" onClick={() => toast('Settings saved successfully!', 'fa-check')}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 6 }} />Save Changes</button>
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: '22px 20px' }}>
          <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-hospital" style={{ color: '#0EA5E9', marginRight: 6 }} />Clinic Information</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div><label className="form-label">Clinic Name</label><input type="text" className="form-input" defaultValue="KID Clinic: Kids Integrated Development Center" /></div>
            <div><label className="form-label">Address</label><input type="text" className="form-input" defaultValue="123 Therapy Lane, Quezon City, Metro Manila 1100" /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label className="form-label">Phone</label><input type="tel" className="form-input" defaultValue="+63 2 8123 4567" /></div>
              <div><label className="form-label">Email</label><input type="email" className="form-input" defaultValue="info@kidclinic.ph" /></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label className="form-label">Operating Hours (Weekdays)</label><input type="text" className="form-input" defaultValue="8:00 AM – 5:00 PM" /></div>
              <div><label className="form-label">Operating Hours (Saturday)</label><input type="text" className="form-input" defaultValue="8:00 AM – 12:00 PM" /></div>
            </div>
            <div><label className="form-label">Website URL</label><input type="url" className="form-input" defaultValue="https://www.kidclinic.ph" /></div>
          </div>
        </div>
        <div className="card" style={{ padding: '22px 20px' }}>
          <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-palette" style={{ color: '#0D9488', marginRight: 6 }} />Branding</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, padding: 16, border: '1px dashed #E2E8F0', borderRadius: 12, background: '#F8FAFC' }}>
            <div style={{ width: 64, height: 64, borderRadius: 14, background: 'linear-gradient(135deg,#0EA5E9,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="fa-solid fa-child-reaching" style={{ color: '#fff', fontSize: 28 }} /></div>
            <div><div style={{ fontWeight: 600, color: '#0F172A', fontSize: 14 }}>Current Logo</div><div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>PNG or SVG · Max 2MB · Recommended 256×256</div><button className="btn-edit" style={{ marginTop: 8, fontSize: 11 }} onClick={() => toast('Logo upload opened', 'fa-upload')}><i className="fa-solid fa-upload" /> Upload New Logo</button></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div><label className="form-label">Primary Color</label><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><input type="color" defaultValue="#0EA5E9" style={{ width: 40, height: 38, border: 'none', borderRadius: 8, cursor: 'pointer' }} /><input type="text" className="form-input" defaultValue="#0EA5E9" style={{ flex: 1 }} /></div></div>
            <div><label className="form-label">Secondary Color</label><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><input type="color" defaultValue="#0D9488" style={{ width: 40, height: 38, border: 'none', borderRadius: 8, cursor: 'pointer' }} /><input type="text" className="form-input" defaultValue="#0D9488" style={{ flex: 1 }} /></div></div>
            <div><label className="form-label">Tagline</label><input type="text" className="form-input" defaultValue="Every Child Deserves to Thrive" /></div>
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: '22px 20px' }}>
          <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-bell" style={{ color: '#F59E0B', marginRight: 6 }} />Notification Preferences</div>
          <div className="status-row"><div><div style={{ fontSize: 13, fontWeight: 500, color: '#0F172A' }}>New reservation requests</div><div style={{ fontSize: 11, color: '#94A3B8' }}>Email + in-app notification</div></div><input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9', width: 16, height: 16 }} /></div>
          <div className="status-row"><div><div style={{ fontSize: 13, fontWeight: 500, color: '#0F172A' }}>Payment confirmations</div><div style={{ fontSize: 11, color: '#94A3B8' }}>Email notification</div></div><input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9', width: 16, height: 16 }} /></div>
          <div className="status-row"><div><div style={{ fontSize: 13, fontWeight: 500, color: '#0F172A' }}>Failed login attempts</div><div style={{ fontSize: 11, color: '#94A3B8' }}>Immediate alert</div></div><input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9', width: 16, height: 16 }} /></div>
          <div className="status-row"><div><div style={{ fontSize: 13, fontWeight: 500, color: '#0F172A' }}>Daily summary report</div><div style={{ fontSize: 11, color: '#94A3B8' }}>Sent at 6:00 PM daily</div></div><input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9', width: 16, height: 16 }} /></div>
          <div className="status-row" style={{ borderBottom: 'none' }}><div><div style={{ fontSize: 13, fontWeight: 500, color: '#0F172A' }}>New user registrations</div><div style={{ fontSize: 11, color: '#94A3B8' }}>Requires admin approval</div></div><input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9', width: 16, height: 16 }} /></div>
        </div>
        <div className="card" style={{ padding: '22px 20px' }}>
          <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-envelope" style={{ color: '#818CF8', marginRight: 6 }} />Email Settings</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div><label className="form-label">SMTP Server</label><input type="text" className="form-input" defaultValue="smtp.kidclinic.ph" /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label className="form-label">SMTP Port</label><input type="text" className="form-input" defaultValue="587" /></div>
              <div><label className="form-label">Encryption</label><select className="form-select"><option>TLS</option><option>SSL</option><option>None</option></select></div>
            </div>
            <div><label className="form-label">From Email</label><input type="email" className="form-input" defaultValue="noreply@kidclinic.ph" /></div>
            <div><label className="form-label">From Name</label><input type="text" className="form-input" defaultValue="KID Clinic" /></div>
            <button className="btn-edit" style={{ width: 'fit-content' }} onClick={() => toast('Test email sent successfully', 'fa-envelope')}><i className="fa-solid fa-paper-plane" style={{ marginRight: 4 }} />Send Test Email</button>
          </div>
        </div>
      </div>
      <div className="card" style={{ padding: '22px 20px', marginBottom: 24 }}>
        <div className="section-title" style={{ marginBottom: 16 }}><i className="fa-solid fa-database" style={{ color: '#10B981', marginRight: 6 }} />Backup Settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Automatic daily backup</span><input type="checkbox" defaultChecked style={{ accentColor: '#0EA5E9', width: 16, height: 16 }} /></div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Backup time</span><select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }}><option>2:00 AM</option><option>3:00 AM</option><option>4:00 AM</option></select></div>
            <div className="status-row"><span style={{ fontSize: 13, color: '#475569' }}>Retention period</span><select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }}><option>30 days</option><option>60 days</option><option>90 days</option></select></div>
            <div className="status-row" style={{ borderBottom: 'none' }}><span style={{ fontSize: 13, color: '#475569' }}>Last backup</span><span style={{ fontWeight: 600, fontSize: 13, color: '#16A34A' }}>Today, 2:00 AM · Success</span></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
            <button className="qa-btn" style={{ width: 'auto', padding: '12px 16px' }} onClick={() => toast('Manual backup started…', 'fa-database')}><div className="qa-icon" style={{ background: '#DCFCE7', color: '#10B981' }}><i className="fa-solid fa-cloud-arrow-up" /></div>Run Backup Now</button>
            <button className="qa-btn" style={{ width: 'auto', padding: '12px 16px' }} onClick={() => toast('Backup history opened', 'fa-clock-rotate-left')}><div className="qa-icon" style={{ background: '#E0F2FE', color: '#0EA5E9' }}><i className="fa-solid fa-clock-rotate-left" /></div>View Backup History</button>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" onClick={() => toast('Changes discarded', 'fa-rotate-left')}>Discard Changes</button>
        <button className="btn-primary" onClick={() => toast('Settings saved successfully!', 'fa-check')}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 6 }} />Save Changes</button>
      </div>
      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System</span></div>
    </div>
  );
}

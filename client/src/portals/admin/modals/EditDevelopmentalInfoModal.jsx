import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';

export default function EditDevelopmentalInfoModal({ data, closeModal }) {
  const fields = data.fields || [];
  const existing = (data.values || {}).dev_functional_data || {};
  const [form, setForm] = useState(() => {
    const init = {};
    for (const f of fields) init[f.id] = existing[f.id] || '';
    return init;
  });
  const [saving, setSaving] = useState(false);

  const bySection = {};
  fields.forEach(f => { (bySection[f.section] ||= []).push(f); });

  async function submit() {
    setSaving(true);
    try {
      await data.onSave({ dev_functional_data: form });
      closeModal();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={<><i className="fa-solid fa-child-reaching" style={{ color: '#4F46E5', marginRight: 8 }} />Edit Development &amp; Functional Information</>} onClose={closeModal} width={640}>
      {fields.length === 0 ? (
        <div style={{ fontSize: 13, color: '#94A3B8' }}>No fields have been configured yet, use "Manage Fields" to add some first.</div>
      ) : Object.entries(bySection).map(([section, sectionFields]) => (
        <div key={section}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginBottom: 8 }}>{section}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            {sectionFields.map(f => (
              <div key={f.id} style={f.field_type === 'text' && f.label.length > 30 ? { gridColumn: '1/-1' } : undefined}>
                <label className="form-label">{f.label}</label>
                {f.field_type === 'select' ? (
                  <select className="form-select" value={form[f.id] || ''} onChange={e => setForm(prev => ({ ...prev, [f.id]: e.target.value }))}>
                    <option value="">- Select -</option>
                    {(f.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                ) : (
                  <input className="form-input" value={form[f.id] || ''} onChange={e => setForm(prev => ({ ...prev, [f.id]: e.target.value }))} />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
        <button className="btn-secondary" onClick={closeModal} disabled={saving}>Cancel</button>
        <button className="btn-primary" disabled={saving || fields.length === 0} onClick={submit}><i className="fa-solid fa-floppy-disk" style={{ marginRight: 5 }} />{saving ? 'Saving…' : 'Save Changes'}</button>
      </div>
    </Modal>
  );
}

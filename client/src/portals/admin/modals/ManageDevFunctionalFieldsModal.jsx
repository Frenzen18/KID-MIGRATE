import { useState } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { api } from '../../../api.js';

export default function ManageDevFunctionalFieldsModal({ data, closeModal, toast }) {
  const [fields, setFields] = useState(null); // null = loading
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null); // field being added/edited, or null
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const res = await api('/dev-functional-fields/all');
      setFields(res || []);
    } catch (e) {
      setErr(e.message || 'Failed to load fields');
    }
  }
  if (fields === null && !err) load();

  function startAdd() {
    setEditing({ section: '', label: '', field_type: 'select', optionsText: 'Yes, No, With Support', required: false, sort_order: (fields?.length || 0) + 1 });
  }
  function startEdit(f) {
    setEditing({ ...f, optionsText: (f.options || []).join(', ') });
  }

  async function saveField() {
    setSaving(true);
    setErr('');
    try {
      const needsOptions = editing.field_type === 'select' || editing.field_type === 'select_other';
      const body = {
        section: editing.section, label: editing.label, field_type: editing.field_type,
        sort_order: editing.sort_order, required: editing.required === true,
        options: needsOptions ? editing.optionsText.split(',').map(s => s.trim()).filter(Boolean) : null
      };
      if (!body.section.trim() || !body.label.trim()) { setErr('Section and label are required.'); setSaving(false); return; }
      if (needsOptions && body.options.length < 2) { setErr('This field type needs at least 2 options.'); setSaving(false); return; }

      if (editing.id) {
        await api('/dev-functional-fields/' + editing.id, { method: 'PUT', body });
      } else {
        await api('/dev-functional-fields', { method: 'POST', body });
      }
      setEditing(null);
      await load();
      if (data.onChanged) data.onChanged();
      toast('Form field saved', 'fa-check');
    } catch (e) {
      setErr(e.message || 'Failed to save field');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(f) {
    try {
      if (f.active) {
        await api('/dev-functional-fields/' + f.id, { method: 'DELETE' });
      } else {
        await api('/dev-functional-fields/' + f.id, { method: 'PUT', body: { active: true } });
      }
      await load();
      if (data.onChanged) data.onChanged();
    } catch (e) {
      setErr(e.message || 'Failed to update field');
    }
  }

  const bySection = {};
  (fields || []).forEach(f => { (bySection[f.section] ||= []).push(f); });

  return (
    <Modal title={<><i className="fa-solid fa-sliders" style={{ color: '#4F46E5', marginRight: 8 }} />Manage Development &amp; Functional Fields</>} onClose={closeModal} width={680}>
      {err && <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '9px 13px', fontSize: 12.5, color: '#DC2626', marginBottom: 14, fontWeight: 600 }}>{err}</div>}

      {editing ? (
        <div style={{ padding: 16, borderRadius: 10, border: '1px solid #E2E8F0', background: '#FAFBFC', marginBottom: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginBottom: 12 }}>{editing.id ? 'Edit Field' : 'Add Field'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div><label className="form-label">Section</label><input className="form-input" value={editing.section} onChange={e => setEditing(f => ({ ...f, section: e.target.value }))} placeholder="e.g. Self-Care Skills" /></div>
            <div><label className="form-label">Field Type</label>
              <select className="form-select" value={editing.field_type} onChange={e => setEditing(f => ({ ...f, field_type: e.target.value }))}>
                <option value="select">Multiple Choice</option>
                <option value="select_other">Multiple Choice + Others</option>
                <option value="text">Free Text</option>
              </select>
            </div>
            <div style={{ gridColumn: '1/-1' }}><label className="form-label">Question / Label</label><input className="form-input" value={editing.label} onChange={e => setEditing(f => ({ ...f, label: e.target.value }))} placeholder="e.g. Able to dress independently" /></div>
            {(editing.field_type === 'select' || editing.field_type === 'select_other') && (
              <div style={{ gridColumn: '1/-1' }}>
                <label className="form-label">Options (comma-separated)</label>
                <input className="form-input" value={editing.optionsText} onChange={e => setEditing(f => ({ ...f, optionsText: e.target.value }))} placeholder="Yes, No, With Support" />
                {editing.field_type === 'select_other' && <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>An "Others" option (with a text box) is added automatically, no need to list it here.</div>}
              </div>
            )}
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#334155', cursor: 'pointer' }}>
                <input type="checkbox" checked={editing.required === true} onChange={e => setEditing(f => ({ ...f, required: e.target.checked }))} style={{ width: 14, height: 14, accentColor: '#1F4E9E', cursor: 'pointer' }} />
                Required (parents must answer this before submitting)
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn-secondary" onClick={() => { setEditing(null); setErr(''); }} disabled={saving}>Cancel</button>
            <button className="btn-primary" onClick={saveField} disabled={saving}>{saving ? 'Saving…' : 'Save Field'}</button>
          </div>
        </div>
      ) : (
        <button className="btn-primary" style={{ marginBottom: 16 }} onClick={startAdd}><i className="fa-solid fa-plus" style={{ marginRight: 5 }} />Add Field</button>
      )}

      {fields === null ? (
        <div style={{ textAlign: 'center', padding: 24, color: '#94A3B8', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {Object.entries(bySection).map(([section, sectionFields]) => (
            <div key={section} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{section}</div>
              {sectionFields.map(f => (
                <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderRadius: 8, background: f.active ? '#fff' : '#F8FAFC', border: '1px solid #F1F5F9', marginBottom: 6, opacity: f.active ? 1 : 0.6 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{f.label}{f.required && <span style={{ color: '#DC2626' }}> *</span>}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>{f.field_type === 'select' ? (f.options || []).join(' · ') : f.field_type === 'select_other' ? [...(f.options || []), 'Others'].join(' · ') : 'Free text'}{f.required ? ' · Required' : ''}{!f.active ? ' · Removed' : ''}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => startEdit(f)}>Edit</button>
                    <button className={f.active ? 'btn-danger' : 'btn-edit'} style={{ fontSize: 11 }} onClick={() => toggleActive(f)}>{f.active ? 'Remove' : 'Restore'}</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn-secondary" onClick={closeModal}>Close</button>
      </div>
    </Modal>
  );
}

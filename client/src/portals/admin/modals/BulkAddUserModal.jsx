import { useState, useRef } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { filterPhoneInput, formatPhoneDisplay } from '../../../phoneInput.js';
import { sanitizeNameInput, hasInvalidNameChars, INVALID_NAME_MSG } from '../../../nameInput.js';
import { passwordMeetsPolicy } from '../../../components/PasswordChecklist.jsx';
import { ROLE_MAP, DEFAULT_TEMP_PASSWORD } from './AddUserModal.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// role code (what the API/ROLE_MAP values use) -> its display label, so a CSV
// exported from somewhere else can say "ot" or "parent" instead of having to
// match the exact dropdown label word-for-word.
const ROLE_CODE_TO_LABEL = Object.fromEntries(Object.entries(ROLE_MAP).map(([label, v]) => [v.role, label]));

function emptyRow(defaultRole) {
  return { first: '', last: '', email: '', phone: '+63', role: defaultRole || '', error: '' };
}

/** Minimal RFC4180 CSV parser: handles quoted fields, escaped "" quotes, and
 *  commas/newlines inside quotes. Good enough for a simple name/email/phone/role
 *  import without pulling in a whole CSV library for it. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore, \n (or end of text) closes the row */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/** Same PH-mobile normalization AddUserModal uses, kept in sync by hand. */
function normalizeRowPhone(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '+63') return { phone: '', error: null };
  const digits = trimmed.replace(/\D/g, '');
  if (/^09\d{9}$/.test(digits)) return { phone: '+63' + digits.slice(1), error: null };
  if (/^639\d{9}$/.test(digits)) return { phone: '+' + digits, error: null };
  return { phone: '', error: 'Phone must be a complete PH mobile number, e.g. +639171234567' };
}

/**
 * Bulk version of AddUserModal: a handful of repeatable rows instead of one
 * form, submitted one request per row (same POST /users the single-add flow
 * uses, see Users.jsx's handleAddUser) via Promise.allSettled rather than
 * Promise.all, a bad row (duplicate email, bad name, ...) must not sink the
 * good rows sitting next to it in the same batch. Rows that fail stay in the
 * form with their own error shown inline so the admin can fix and resubmit
 * just those, successful rows disappear from the list.
 */
export default function BulkAddUserModal({ data, closeModal, toast }) {
  const roleOptions = data.roleOptions || Object.keys(ROLE_MAP);
  const isLocked = roleOptions.length === 1;
  const [rows, setRows] = useState(() => Array.from({ length: 3 }, () => emptyRow(isLocked ? roleOptions[0] : '')));
  const [password, setPassword] = useState(DEFAULT_TEMP_PASSWORD);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  function downloadCsvTemplate() {
    const header = isLocked ? ['First Name', 'Last Name', 'Email', 'Phone'] : ['First Name', 'Last Name', 'Email', 'Phone', 'Role'];
    const example = isLocked
      ? ['Maria', 'Santos', 'maria.santos@example.com', '+639171234567']
      : ['Maria', 'Santos', 'maria.santos@example.com', '+639171234567', roleOptions[0]];
    const csv = [header, example].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bulk-add-users-template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function handleCsvFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // same file picked twice in a row should still fire onChange
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importCsvText(String(reader.result || ''));
    reader.onerror = () => toast('Could not read that file', 'fa-circle-exclamation');
    reader.readAsText(file);
  }

  function importCsvText(text) {
    const table = parseCsv(text);
    if (!table.length) {
      toast('That CSV looks empty', 'fa-triangle-exclamation');
      return;
    }
    const header = table[0].map(h => h.trim().toLowerCase());
    const col = {
      first: header.findIndex(h => h.startsWith('first')),
      last: header.findIndex(h => h.startsWith('last')),
      email: header.findIndex(h => h.startsWith('email')),
      phone: header.findIndex(h => h.startsWith('phone') || h.startsWith('contact')),
      role: header.findIndex(h => h.startsWith('role')),
    };
    if (col.first === -1 || col.email === -1) {
      toast('CSV needs at least a "First Name" and an "Email" column, see the template', 'fa-triangle-exclamation');
      return;
    }
    const dataLines = table.slice(1);
    const imported = dataLines.map(cols => {
      const rawRole = col.role !== -1 ? (cols[col.role] || '').trim() : '';
      const roleMatch = isLocked
        ? roleOptions[0]
        : (roleOptions.find(r => r.toLowerCase() === rawRole.toLowerCase()) || ROLE_CODE_TO_LABEL[rawRole.toLowerCase()] || '');
      const rawPhone = col.phone !== -1 ? (cols[col.phone] || '').trim() : '';
      return {
        first: sanitizeNameInput(cols[col.first] || ''),
        last: sanitizeNameInput(col.last !== -1 ? (cols[col.last] || '') : ''),
        email: (cols[col.email] || '').trim(),
        phone: rawPhone ? formatPhoneDisplay(filterPhoneInput(rawPhone)) : '+63',
        role: roleMatch,
        error: ''
      };
    }).filter(r => r.first.trim() || r.email.trim());

    if (!imported.length) {
      toast('No usable rows found in that CSV', 'fa-triangle-exclamation');
      return;
    }
    // Appends onto whatever's already in the form rather than replacing it,
    // dropping only the still-blank starter rows, so importing twice (or
    // importing after typing a few rows by hand) doesn't lose anything.
    setRows(prev => {
      const kept = prev.filter(r => r.first.trim() || r.last.trim() || r.email.trim());
      return [...kept, ...imported];
    });
    toast('Imported ' + imported.length + ' row' + (imported.length === 1 ? '' : 's') + ' from CSV, review below before creating', 'fa-file-csv');
  }

  function updateRow(idx, patch) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch, error: '' } : r));
  }
  function addRow() {
    setRows(prev => [...prev, emptyRow(isLocked ? roleOptions[0] : '')]);
  }
  function removeRow(idx) {
    setRows(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx));
  }

  const filledCount = rows.filter(r => r.first.trim() || r.email.trim()).length;

  async function submitBulk() {
    const pw = password.trim();
    if (!passwordMeetsPolicy(pw)) {
      toast('Temporary password does not meet all the requirements shown below the field', 'fa-triangle-exclamation');
      return;
    }
    // Rows left completely blank are just ignored, not everyone needs all 3 starter rows filled.
    const candidates = rows
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.first.trim() || r.last.trim() || r.email.trim());

    if (!candidates.length) {
      toast('Fill in at least one row first', 'fa-triangle-exclamation');
      return;
    }

    // Client-side validation first, so a typo doesn't cost a round trip, same
    // checks AddUserModal runs for a single row.
    const validated = candidates.map(({ r, idx }) => {
      if (!r.first.trim()) return { idx, error: 'First name is required' };
      if (hasInvalidNameChars(r.first) || (r.last && hasInvalidNameChars(r.last))) return { idx, error: INVALID_NAME_MSG };
      if (!r.email.trim() || !EMAIL_RE.test(r.email.trim())) return { idx, error: 'Enter a valid email address' };
      if (!r.role) return { idx, error: 'Pick a role' };
      const { phone, error: phoneErr } = normalizeRowPhone(r.phone);
      if (phoneErr) return { idx, error: phoneErr };
      return {
        idx,
        payload: {
          email: r.email.trim(), password: pw,
          first_name: r.first.trim(), last_name: r.last.trim(),
          full_name: r.first.trim() + (r.last.trim() ? ' ' + r.last.trim() : ''),
          role: (ROLE_MAP[r.role] || {}).role || 'staff',
          contact: phone
        }
      };
    });

    const localErrors = validated.filter(v => v.error);
    if (localErrors.length) {
      setRows(prev => prev.map((r, i) => {
        const found = localErrors.find(e => e.idx === i);
        return found ? { ...r, error: found.error } : r;
      }));
      toast('Fix the highlighted row' + (localErrors.length > 1 ? 's' : '') + ' before submitting', 'fa-triangle-exclamation');
      return;
    }

    setBusy(true);
    const results = await Promise.allSettled(validated.map(v => data.onSaveOne(v.payload)));
    setBusy(false);

    const failedIdx = new Set();
    let successCount = 0;
    results.forEach((res, i) => {
      const idx = validated[i].idx;
      if (res.status === 'fulfilled' && res.value?.ok) {
        successCount++;
      } else {
        failedIdx.add(idx);
        const msg = res.status === 'fulfilled' ? (res.value?.error || 'Failed') : (res.reason?.message || 'Failed');
        setRows(prev => prev.map((r, i2) => i2 === idx ? { ...r, error: msg } : r));
      }
    });

    // Drop the rows that succeeded, keep the failed ones (with their error) so
    // they can be corrected without retyping everything else.
    if (successCount) {
      setRows(prev => {
        const kept = prev.filter((_, i) => failedIdx.has(i) || !(prev[i].first.trim() || prev[i].last.trim() || prev[i].email.trim()));
        return kept.length ? kept : [emptyRow(isLocked ? roleOptions[0] : '')];
      });
      data.onDone?.();
    }

    if (failedIdx.size === 0) {
      toast(successCount + ' user' + (successCount > 1 ? 's' : '') + ' created successfully!', 'fa-user-plus');
      closeModal();
    } else if (successCount) {
      toast(successCount + ' created, ' + failedIdx.size + ' failed, see highlighted row' + (failedIdx.size > 1 ? 's' : '') + ' below', 'fa-triangle-exclamation');
    } else {
      toast('Failed to create ' + (failedIdx.size > 1 ? 'any users' : 'the user') + ', see the error below', 'fa-circle-exclamation');
    }
  }

  return (
    <Modal title="Bulk Add Users" onClose={closeModal} width={720}>
      <div style={{ fontSize: 12.5, color: '#64748B', marginBottom: 16 }}>
        Add several accounts at once, blank rows are skipped. Every account gets the same temporary password below and is prompted to set their own on first login.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16, padding: 12, background: '#F8FAFC', border: '1px solid #F1F5F9', borderRadius: 10 }}>
        <i className="fa-solid fa-file-csv" style={{ color: '#0D9488', fontSize: 15 }} />
        <div style={{ fontSize: 12, color: '#64748B', flex: '1 1 200px' }}>
          Have a spreadsheet already? Import it as a CSV instead of typing each row.
        </div>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleCsvFile} />
        <button type="button" className="btn-secondary" style={{ padding: '7px 14px', fontSize: 12 }} onClick={downloadCsvTemplate}><i className="fa-solid fa-download" style={{ marginRight: 5 }} />Download Template</button>
        <button type="button" className="btn-secondary" style={{ padding: '7px 14px', fontSize: 12 }} onClick={() => fileInputRef.current?.click()}><i className="fa-solid fa-upload" style={{ marginRight: 5 }} />Upload CSV</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        {rows.map((r, idx) => (
          <div key={idx} style={{ border: r.error ? '1px solid #FCA5A5' : '1px solid #E2E8F0', background: r.error ? '#FEF2F2' : '#F8FAFC', borderRadius: 10, padding: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: isLocked ? '1fr 1fr 1.4fr 1fr auto' : '1fr 1fr 1.4fr 1fr 1.2fr auto', gap: 8, alignItems: 'start' }}>
              <input className="form-input" placeholder="First Name" value={r.first} onChange={e => updateRow(idx, { first: sanitizeNameInput(e.target.value) })} />
              <input className="form-input" placeholder="Last Name" value={r.last} onChange={e => updateRow(idx, { last: sanitizeNameInput(e.target.value) })} />
              <input className="form-input" type="email" placeholder="name@kidclinic.ph" value={r.email} onChange={e => updateRow(idx, { email: e.target.value })} />
              <input className="form-input" type="tel" placeholder="+63 000 000 0000" maxLength={16} value={r.phone} onChange={e => updateRow(idx, { phone: formatPhoneDisplay(filterPhoneInput(e.target.value)) })} />
              {!isLocked && (
                <select className="form-select" value={r.role} onChange={e => updateRow(idx, { role: e.target.value })}>
                  <option value="">Role…</option>
                  {roleOptions.map(ro => <option key={ro} value={ro}>{ro}</option>)}
                </select>
              )}
              <button
                type="button"
                disabled={rows.length <= 1}
                onClick={() => removeRow(idx)}
                title="Remove row"
                style={{ width: 34, height: 38, border: '1px solid #E2E8F0', background: '#fff', borderRadius: 8, color: rows.length <= 1 ? '#CBD5E1' : '#DC2626', cursor: rows.length <= 1 ? 'default' : 'pointer' }}
              ><i className="fa-solid fa-xmark" /></button>
            </div>
            {r.error && <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 6 }}><i className="fa-solid fa-circle-exclamation" style={{ marginRight: 5 }} />{r.error}</div>}
          </div>
        ))}
      </div>

      <button type="button" className="btn-secondary" style={{ marginBottom: 20 }} onClick={addRow}><i className="fa-solid fa-plus" style={{ marginRight: 6 }} />Add Another Row</button>

      <div style={{ marginBottom: 20 }}>
        <label className="form-label">Temporary Password (used for every account created here)</label>
        <input type="password" className="form-input" value={password} onChange={e => setPassword(e.target.value)} placeholder="Create a temporary password" />
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>Auto-filled with the clinic's default temporary password, edit if needed.</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" onClick={closeModal} disabled={busy}>Cancel</button>
        <button className="btn-primary" onClick={submitBulk} disabled={busy}>
          {busy ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Creating…</> : <>Create {filledCount > 0 ? filledCount : ''} User{filledCount === 1 ? '' : 's'}</>}
        </button>
      </div>
    </Modal>
  );
}

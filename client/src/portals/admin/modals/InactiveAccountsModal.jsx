import { useState, useEffect, useMemo } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { api } from '../../../api.js';

const PAGE_SIZE = 10;

/** Review queue for accounts the inactivity-cleanup sweep flagged (see
 *  server/lib/accountCleanup.js), opened on demand from a one-line banner on
 *  User Management instead of rendering inline there, this list could grow
 *  into the dozens/hundreds over time and shouldn't push the actual account
 *  tables off the page. Fetches its own data fresh every time it opens. */
export default function InactiveAccountsModal({ data, closeModal, toast }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmTargets, setConfirmTargets] = useState(null); // account[] pending delete confirmation, single or bulk

  const fetchAccounts = () => {
    setLoading(true);
    api('/users/inactive-review')
      .then(list => { setAccounts(list); setSelected(new Set()); })
      .catch(err => toast('Failed to load flagged accounts: ' + err.message, 'fa-triangle-exclamation'))
      .finally(() => setLoading(false));
  };
  useEffect(fetchAccounts, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(a =>
      (a.full_name || '').toLowerCase().includes(q) ||
      (a.email || '').toLowerCase().includes(q) ||
      (a.linked_children || []).some(c => c.full_name.toLowerCase().includes(q))
    );
  }, [accounts, search]);
  const visible = filtered.slice(0, visibleCount);
  const allVisibleSelected = visible.length > 0 && visible.every(a => selected.has(a.id));

  function toggleOne(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setSelected(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visible.forEach(a => next.delete(a.id));
        return next;
      }
      return new Set([...prev, ...visible.map(a => a.id)]);
    });
  }

  function formatDate(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function confirmDelete() {
    const targets = confirmTargets;
    setConfirmTargets(null);
    setBusy(true);
    try {
      const outcomes = await Promise.allSettled(targets.map(a => api('/users/inactive-review/' + a.id + '/confirm-delete', { method: 'POST' })));
      const failedCount = outcomes.filter(o => o.status === 'rejected').length;
      const okIds = new Set(targets.filter((a, i) => outcomes[i].status === 'fulfilled').map(a => a.id));
      setAccounts(prev => prev.filter(a => !okIds.has(a.id)));
      setSelected(prev => { const next = new Set(prev); okIds.forEach(id => next.delete(id)); return next; });
      if (failedCount) toast(`${okIds.size} deleted, ${failedCount} failed`, 'fa-triangle-exclamation');
      else toast(targets.length > 1 ? `${targets.length} inactive accounts deleted` : 'Inactive account deleted', 'fa-trash');
      data.onChanged?.();
    } catch (err) {
      toast('Error: ' + err.message, 'fa-triangle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  if (confirmTargets) {
    const totalChildren = confirmTargets.reduce((n, a) => n + (a.linked_children?.length || 0), 0);
    return (
      <Modal title={<><i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--color-danger-strong)', marginRight: 8 }} />Delete Inactive Account{confirmTargets.length > 1 ? 's' : ''}</>} onClose={() => setConfirmTargets(null)} width={460}>
        <p style={{ fontSize: 13.5, color: '#475569', margin: '0 0 10px' }}>
          You are about to permanently delete {confirmTargets.length > 1 ? `these ${confirmTargets.length} accounts` : 'this account'}:
        </p>
        <div style={{ padding: '10px 13px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, marginBottom: 14, fontSize: 13, color: '#0F172A', maxHeight: 160, overflowY: 'auto' }}>
          {confirmTargets.map(a => (
            <div key={a.id} style={{ fontWeight: 600, padding: '3px 0' }}>
              {a.full_name || a.email}
              {a.linked_children?.length ? <span style={{ fontWeight: 400, color: '#64748B' }}> ({a.linked_children.map(c => c.full_name).join(', ')})</span> : null}
            </div>
          ))}
        </div>
        <div style={{ padding: '11px 13px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, marginBottom: 18, fontSize: 12.5, color: '#991B1B' }}>
          <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />
          None of these ever booked an Initial Assessment{totalChildren > 0 ? `, ${totalChildren} linked child record${totalChildren > 1 ? 's' : ''} will also be removed` : ''}. This cannot be undone.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn-secondary" onClick={() => setConfirmTargets(null)}>Cancel</button>
          <button className="btn-primary" style={{ background: 'var(--color-danger-strong)', borderColor: 'var(--color-danger-strong)' }} disabled={busy} onClick={confirmDelete}>
            <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-trash')} style={{ marginRight: 6 }} />Delete {confirmTargets.length > 1 ? `${confirmTargets.length} Accounts` : 'Account'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={<><i className="fa-solid fa-user-slash" style={{ color: 'var(--color-danger-strong)', marginRight: 8 }} />Inactive Accounts Flagged for Review</>} onClose={closeModal} width={700}>
      <div style={{ fontSize: 12, color: '#64748B', marginBottom: 14 }}>
        These guardian accounts never booked an Initial Assessment and have been inactive for 2 months. Confirm to permanently remove them (and any child record they linked).
      </div>
      <input
        className="form-input" placeholder="Search by name, email, or linked child…" value={search}
        onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
        style={{ marginBottom: 12 }}
      />
      {loading ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: '#94A3B8', fontSize: 13 }}>
          <i className="fa-solid fa-circle-check" style={{ marginRight: 6 }} />{accounts.length === 0 ? 'No accounts currently flagged.' : 'No accounts match this search.'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px 10px', borderBottom: '1px solid #F1F5F9', marginBottom: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#64748B', cursor: 'pointer' }}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} style={{ margin: 0 }} />
              Select all shown ({visible.length})
            </label>
            {selected.size > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#0F172A' }}>{selected.size} selected</span>
                <button
                  className="btn-primary" style={{ fontSize: 12, padding: '6px 12px', background: 'var(--color-danger-strong)', borderColor: 'var(--color-danger-strong)' }} disabled={busy}
                  onClick={() => setConfirmTargets(accounts.filter(a => selected.has(a.id)))}
                >
                  <i className="fa-solid fa-trash" style={{ marginRight: 5 }} />Delete Selected
                </button>
              </div>
            )}
          </div>
          <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', border: '1px solid #E2E8F0', borderRadius: 9, padding: '10px 12px', background: selected.has(a.id) ? '#F0F9FF' : undefined }}>
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} style={{ margin: 0, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{a.full_name || a.email}</div>
                  <div style={{ fontSize: 11.5, color: '#64748B' }}>
                    {a.email}{a.contact ? ' · ' + a.contact : ''} · Signed up {formatDate(a.created_at)}
                    {a.linked_children?.length ? ` · Linked: ${a.linked_children.map(c => c.full_name).join(', ')}` : ' · No child linked'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn-primary" style={{ fontSize: 12, padding: '7px 12px', background: 'var(--color-danger-strong)', borderColor: 'var(--color-danger-strong)' }} disabled={busy} onClick={() => setConfirmTargets([a])}>
                    <i className="fa-solid fa-trash" style={{ marginRight: 5 }} />Delete
                  </button>
                </div>
              </div>
            ))}
            {visibleCount < filtered.length && (
              <button className="btn-secondary" style={{ fontSize: 12, padding: '8px 12px', alignSelf: 'center' }} onClick={() => setVisibleCount(c => c + PAGE_SIZE)}>
                Show More ({filtered.length - visibleCount} remaining)
              </button>
            )}
          </div>
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
        <button className="btn-secondary" onClick={closeModal}>Close</button>
      </div>
    </Modal>
  );
}

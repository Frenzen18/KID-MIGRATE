import { useState, useEffect, useMemo } from 'react';
import { Modal } from '../../../components/ui.jsx';
import { api } from '../../../api.js';

const PAGE_SIZE = 10;

/** Review queue for child records the per-child inactivity-cleanup sweep
 *  flagged (see server/lib/accountCleanup.js, sweepInactiveChildren) -
 *  companion to InactiveAccountsModal, but scoped to one child at a time
 *  instead of a whole guardian login: a guardian with several linked
 *  children only ever risks losing the specific child that never completed
 *  its own Initial Assessment, never a sibling that did, and never the
 *  guardian's own account. Opened on demand from a one-line banner on Client
 *  Records instead of rendering inline, this list could grow large over time. */
export default function InactiveChildrenModal({ data, closeModal, toast }) {
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmTargets, setConfirmTargets] = useState(null); // child[] pending delete confirmation, single or bulk

  const fetchChildren = () => {
    setLoading(true);
    api('/clients/inactive-review')
      .then(list => { setChildren(list); setSelected(new Set()); })
      .catch(err => toast('Failed to load flagged child records: ' + err.message, 'fa-triangle-exclamation'))
      .finally(() => setLoading(false));
  };
  useEffect(fetchChildren, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return children;
    return children.filter(c =>
      (c.full_name || '').toLowerCase().includes(q) ||
      (c.guardian?.full_name || '').toLowerCase().includes(q) ||
      (c.guardian?.email || '').toLowerCase().includes(q)
    );
  }, [children, search]);
  const visible = filtered.slice(0, visibleCount);
  const allVisibleSelected = visible.length > 0 && visible.every(c => selected.has(c.id));

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
        visible.forEach(c => next.delete(c.id));
        return next;
      }
      return new Set([...prev, ...visible.map(c => c.id)]);
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
      const outcomes = await Promise.allSettled(targets.map(c => api('/clients/inactive-review/' + c.id + '/confirm-delete', { method: 'POST' })));
      const failedCount = outcomes.filter(o => o.status === 'rejected').length;
      const okIds = new Set(targets.filter((c, i) => outcomes[i].status === 'fulfilled').map(c => c.id));
      setChildren(prev => prev.filter(c => !okIds.has(c.id)));
      setSelected(prev => { const next = new Set(prev); okIds.forEach(id => next.delete(id)); return next; });
      if (failedCount) toast(`${okIds.size} deleted, ${failedCount} failed`, 'fa-triangle-exclamation');
      else toast(targets.length > 1 ? `${targets.length} child records deleted` : 'Child record deleted', 'fa-trash');
      data.onChanged?.();
    } catch (err) {
      toast('Error: ' + err.message, 'fa-triangle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  if (confirmTargets) {
    return (
      <Modal title={<><i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--color-danger-strong)', marginRight: 8 }} />Delete Child Record{confirmTargets.length > 1 ? 's' : ''}</>} onClose={() => setConfirmTargets(null)} width={460}>
        <p style={{ fontSize: 13.5, color: '#475569', margin: '0 0 10px' }}>
          You are about to permanently delete {confirmTargets.length > 1 ? `these ${confirmTargets.length} child records` : 'this child record'}:
        </p>
        <div style={{ padding: '10px 13px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, marginBottom: 14, fontSize: 13, color: '#0F172A', maxHeight: 160, overflowY: 'auto' }}>
          {confirmTargets.map(c => (
            <div key={c.id} style={{ fontWeight: 600, padding: '3px 0' }}>
              {c.full_name}
              <span style={{ fontWeight: 400, color: '#64748B' }}> (guardian: {c.guardian?.full_name || c.guardian?.email || 'unknown'})</span>
            </div>
          ))}
        </div>
        <div style={{ padding: '11px 13px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, marginBottom: 18, fontSize: 12.5, color: '#991B1B' }}>
          <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />
          None of these ever completed an Initial Assessment. The guardian's login and any other linked child are not affected. This cannot be undone.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn-secondary" onClick={() => setConfirmTargets(null)}>Cancel</button>
          <button className="btn-primary" style={{ background: 'var(--color-danger-strong)', borderColor: 'var(--color-danger-strong)' }} disabled={busy} onClick={confirmDelete}>
            <i className={'fa-solid ' + (busy ? 'fa-spinner fa-spin' : 'fa-trash')} style={{ marginRight: 6 }} />Delete {confirmTargets.length > 1 ? `${confirmTargets.length} Records` : 'Record'}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={<><i className="fa-solid fa-user-slash" style={{ color: 'var(--color-danger-strong)', marginRight: 8 }} />Inactive Child Records Flagged for Review</>} onClose={closeModal} width={700}>
      <div style={{ fontSize: 12, color: '#64748B', marginBottom: 14 }}>
        These linked children never completed an Initial Assessment and have been inactive for 2 months. A guardian's other children (if any completed theirs) and the guardian's own login are never affected.
      </div>
      <input
        className="form-input" placeholder="Search by child name, guardian name, or email…" value={search}
        onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
        style={{ marginBottom: 12 }}
      />
      {loading ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 0', color: '#94A3B8', fontSize: 13 }}>
          <i className="fa-solid fa-circle-check" style={{ marginRight: 6 }} />{children.length === 0 ? 'No child records currently flagged.' : 'No records match this search.'}
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
                  onClick={() => setConfirmTargets(children.filter(c => selected.has(c.id)))}
                >
                  <i className="fa-solid fa-trash" style={{ marginRight: 5 }} />Delete Selected
                </button>
              </div>
            )}
          </div>
          <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', border: '1px solid #E2E8F0', borderRadius: 9, padding: '10px 12px', background: selected.has(c.id) ? '#F0F9FF' : undefined }}>
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} style={{ margin: 0, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{c.full_name}{c.client_code ? <span style={{ fontWeight: 400, color: '#94A3B8' }}> ({c.client_code})</span> : null}</div>
                  <div style={{ fontSize: 11.5, color: '#64748B' }}>
                    Guardian: {c.guardian?.full_name || c.guardian?.email || 'unknown'}{c.guardian?.email ? ' · ' + c.guardian.email : ''} · Linked {formatDate(c.created_at)}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn-primary" style={{ fontSize: 12, padding: '7px 12px', background: 'var(--color-danger-strong)', borderColor: 'var(--color-danger-strong)' }} disabled={busy} onClick={() => setConfirmTargets([c])}>
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

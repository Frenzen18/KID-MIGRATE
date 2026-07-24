import { useState, useEffect } from 'react';
import { api } from '../../../api.js';

/* == page: payments == */

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_PILL = { paid: 'pill-green', pending: 'pill-amber', overdue: 'pill-red', refunded: 'pill' };
// QRPh is a guardian's own self-checkout (online); Cash/Check only ever get
// set when staff/admin book and collect payment in person (offline).
const METHOD_CHANNEL = { QRPh: 'Online', Cash: 'Offline', Check: 'Offline', Unpaid: 'Unpaid' };
const CHANNEL_PILL = { Online: 'pill-blue', Offline: 'pill-teal', Unpaid: 'pill' };

export default function Payments({ go, toast }) {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = () => {
    setLoading(true);
    api('/payments')
      .then(p => setPayments(p || []))
      .catch(() => toast('Failed to load payment data', 'fa-triangle-exclamation'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchAll(); }, []);

  /* ── 11.8 Real printable invoice (browser print, no PDF lib needed) ── */
  const [invoice, setInvoice] = useState(null);
  function printInvoice() { window.print(); }

  const [brand, setBrand] = useState(null);
  useEffect(() => { fetch('/api/settings/branding/public').then(r => r.json()).then(setBrand).catch(() => {}); }, []);

  const [methodFilter, setMethodFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [invoiceSearch, setInvoiceSearch] = useState('');

  // Per-client filter, same "search by code, pick from a datalist autocomplete"
  // pattern Security Audit Logs already uses for its per-user filter, a payment
  // belongs to a client (not a staff/admin account), so client is the "user"
  // this module filters by. Client-side, matching how method/status/invoice
  // are already filtered here (this page never re-queries the server).
  const [clients, setClients] = useState([]);
  const [clientFilter, setClientFilter] = useState(''); // resolved client_id
  const [clientSearchText, setClientSearchText] = useState('');
  useEffect(() => { api('/clients').then(data => setClients(data || [])).catch(() => setClients([])); }, []);

  function selectClient(id) {
    setClientFilter(id);
    const found = id ? clients.find(c => c.id === id) : null;
    setClientSearchText(found ? (found.client_code || found.full_name) : '');
  }
  /** Typing/picking in the "Search by client" field (native datalist autocomplete). */
  function handleClientSearchChange(val) {
    setClientSearchText(val);
    if (!val) { selectClient(''); return; }
    const match = clients.find(c => c.client_code === val || c.id === val);
    if (match) selectClient(match.id);
  }

  const filteredTxns = payments.filter(p =>
    (!methodFilter || (METHOD_CHANNEL[p.method] || p.method) === methodFilter)
    && (!statusFilter || p.status === statusFilter)
    && (!clientFilter || p.client_id === clientFilter)
    && (!invoiceSearch.trim() || (p.invoice_no || '').toLowerCase().includes(invoiceSearch.trim().toLowerCase()))
  );

  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [methodFilter, statusFilter, clientFilter, invoiceSearch]);
  const pageCount = Math.max(1, Math.ceil(filteredTxns.length / PAGE_SIZE));
  const pagedTxns = filteredTxns.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="spa-page" id="spa-payments">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #invoice-print, #invoice-print * { visibility: visible; }
          #invoice-print { position: fixed; top: 0; left: 0; width: 100%; margin: 0; box-shadow: none; border: none; }
        }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Payment Transactions</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={fetchAll}>
            <i className="fa-solid fa-rotate" style={{ color: '#0D9488' }} /> Refresh
          </button>
        </div>
      </div>

      {/* ═══════ ALL TRANSACTIONS ═══════ */}
      <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
        <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div><div className="section-title">All Transactions</div></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 11.5, color: '#94A3B8' }} />
              <input className="form-input" style={{ width: 180, height: 34, fontSize: 12.5, paddingLeft: 30 }} placeholder="Search invoice no." value={invoiceSearch} onChange={e => setInvoiceSearch(e.target.value)} />
            </div>
            <div style={{ position: 'relative' }}>
              <input
                list="payments-client-ids"
                className="form-input"
                style={{ width: 170, height: 34, fontSize: 12.5 }}
                placeholder="Search by client ID…"
                value={clientSearchText}
                onChange={e => handleClientSearchChange(e.target.value)}
              />
              <datalist id="payments-client-ids">
                {clients.map(c => <option key={c.id} value={c.client_code || c.id}>{c.full_name}</option>)}
              </datalist>
            </div>
            {clientFilter && (
              <button className="btn-secondary" style={{ height: 34, fontSize: 12.5 }} onClick={() => selectClient('')}>Clear client</button>
            )}
            <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Status</option><option value="paid">Paid</option><option value="pending">Pending</option><option value="overdue">Overdue</option><option value="refunded">Refunded</option>
            </select>
            <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={methodFilter} onChange={e => setMethodFilter(e.target.value)}>
              <option value="">All Methods</option><option value="Online">Online</option><option value="Offline">Offline</option><option value="Unpaid">Unpaid</option>
            </select>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}><table className="data-table">
          <thead><tr><th style={{ paddingLeft: 24 }}>Invoice No.</th><th>Client</th><th>Method</th><th>Reference</th><th>Amount</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>Loading…</td></tr>}
            {!loading && filteredTxns.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>No transactions match these filters</td></tr>}
            {!loading && pagedTxns.map(p => (
              <tr key={p.id}>
                <td style={{ paddingLeft: 24, fontWeight: 600, fontSize: 12.5 }}>{p.invoice_no || '-'}</td>
                <td><div style={{ fontWeight: 600 }}>{p.clients?.full_name || '-'}</div><div style={{ fontSize: 11, color: '#94A3B8' }}>{p.clients?.guardian_name || ''}</div></td>
                <td><span className={'pill ' + (CHANNEL_PILL[METHOD_CHANNEL[p.method]] || 'pill')} style={{ fontSize: 10 }}>{METHOD_CHANNEL[p.method] || p.method}</span></td>
                <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--cat-1)' }}>{p.reference || '-'}</td>
                <td style={{ fontWeight: 700, color: p.status === 'refunded' ? 'var(--color-warning)' : 'var(--color-success)' }}>₱{Number(p.amount).toLocaleString()}</td>
                <td style={{ fontSize: 12.5 }}>{fmtDate(p.created_at)}</td>
                <td><span className={'pill ' + STATUS_PILL[p.status]} style={{ fontSize: 10 }}>{p.status}</span></td>
                <td style={{ textAlign: 'right', paddingRight: 24 }}><button className="btn-edit" style={{ fontSize: 11 }} onClick={() => setInvoice(p)}><i className="fa-solid fa-file-invoice" /> View</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {!loading && filteredTxns.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderTop: '1px solid #F1F5F9' }}>
            <span style={{ fontSize: 12, color: '#94A3B8' }}>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredTxns.length)} of {filteredTxns.length}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 12, opacity: page === 1 ? .5 : 1 }} disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</button>
              <span style={{ fontSize: 12, color: '#64748B' }}>Page {page} of {pageCount}</span>
              <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 12, opacity: page === pageCount ? .5 : 1 }} disabled={page === pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))}>Next</button>
            </div>
          </div>
        )}
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Secure Payment Checkout</span></div>

      {/* ── Printable invoice modal ── */}
      {invoice && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setInvoice(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 0, width: 520, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div id="invoice-print" style={{ padding: 28, fontFamily: "'Inter',Arial,sans-serif" }}>
              {/* Letterhead */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 18, borderBottom: '3px solid #1F4E9E' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {brand?.logo_url
                    ? <img src={brand.logo_url} alt={brand.clinic_name} style={{ width: 46, height: 46, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
                    : <div style={{ width: 46, height: 46, borderRadius: 10, background: 'linear-gradient(135deg,#1F4E9E,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <i className="fa-solid fa-child-reaching" style={{ color: '#fff', fontSize: 19 }} />
                      </div>}
                  <div>
                    <div style={{ fontFamily: "'Poppins',sans-serif", fontSize: 18, fontWeight: 700, color: '#0F172A', lineHeight: 1.2 }}>{brand?.clinic_name || 'Bloomsdale Therapy Center'}</div>
                    <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>Pediatric Speech &amp; Occupational Therapy</div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>{brand?.address || 'Imus, Cavite, Philippines'}</div>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: "'Poppins',sans-serif", fontSize: 20, fontWeight: 700, color: '#1F4E9E', letterSpacing: '.03em' }}>INVOICE</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 700, color: '#0F172A', marginTop: 4 }}>{invoice.invoice_no || invoice.id}</div>
                  <div style={{ marginTop: 6 }}>
                    <span className={'pill ' + STATUS_PILL[invoice.status]} style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>{invoice.status}</span>
                  </div>
                </div>
              </div>

              {/* Pay To / Bill To / Invoice info */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: '18px 0', borderBottom: '1px solid #F1F5F9' }}>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Pay To</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{brand?.clinic_name || 'Bloomsdale Therapy Center'}</div>
                  <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>{brand?.address || 'Imus, Cavite, Philippines'}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Billed To</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{invoice.clients?.full_name || '-'}</div>
                  {invoice.clients?.guardian_name && <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>Guardian: {invoice.clients.guardian_name}</div>}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 0' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Invoice Date</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{fmtDate(invoice.paid_at || invoice.created_at)}</div>
                </div>
              </div>

              {/* Line items */}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    <th style={{ textAlign: 'left', padding: '9px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid #E2E8F0' }}>Description</th>
                    <th style={{ textAlign: 'right', padding: '9px 10px', fontSize: 10.5, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid #E2E8F0' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: '12px 10px', borderBottom: '1px solid #F1F5F9' }}>
                      <div style={{ fontWeight: 600, color: '#0F172A' }}>{invoice.reservations?.session_type || 'Therapy Session'}</div>
                      <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 2 }}>
                        {invoice.reservations?.date ? fmtDate(invoice.reservations.date) : fmtDate(invoice.paid_at || invoice.created_at)}
                        {invoice.reservations?.time_slot ? ' · ' + invoice.reservations.time_slot : ''}
                        {invoice.reservations?.duration_min ? ' · ' + invoice.reservations.duration_min + ' min' : ''}
                        {invoice.reservations?.therapist_name ? ' · with ' + invoice.reservations.therapist_name : ''}
                      </div>
                    </td>
                    <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 600, color: '#0F172A', verticalAlign: 'top' }}>₱{Number(invoice.amount).toLocaleString()}</td>
                  </tr>
                </tbody>
              </table>

              {/* Totals */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
                <div style={{ width: '55%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 10px', fontSize: 12.5 }}><span style={{ color: '#64748B' }}>Subtotal</span><span style={{ fontWeight: 600, color: '#0F172A' }}>₱{Number(invoice.amount).toLocaleString()}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 10px', marginTop: 4, background: '#F8FAFC', borderRadius: 8 }}>
                    <span style={{ fontWeight: 700, color: '#0F172A' }}>Total {invoice.status === 'refunded' ? 'Refunded' : 'Due/Paid'}</span>
                    <span style={{ fontFamily: "'Poppins',sans-serif", fontSize: 17, fontWeight: 700, color: 'var(--color-success)' }}>₱{Number(invoice.amount).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* Payment details */}
              <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid #E2E8F0' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Payment Details</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
                  <div><span style={{ color: '#64748B' }}>Method: </span><span style={{ fontWeight: 600 }}>{invoice.method}</span></div>
                  <div><span style={{ color: '#64748B' }}>Reference: </span><span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--cat-1)' }}>{invoice.reference || '-'}</span></div>
                  {invoice.paid_at && <div><span style={{ color: '#64748B' }}>Paid At: </span><span style={{ fontWeight: 600 }}>{fmtDate(invoice.paid_at)}</span></div>}
                </div>
              </div>

              {/* Footer note */}
              <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid #E2E8F0', textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#475569', fontWeight: 600 }}>Thank you for trusting {brand?.clinic_name || 'Bloomsdale Therapy Center'} with your child's care.</div>
                <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>This is a system-generated invoice and does not require a signature.</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '0 24px 24px' }}>
              <button className="btn-primary" style={{ flex: 1, padding: 10 }} onClick={printInvoice}><i className="fa-solid fa-print" style={{ marginRight: 5 }} />Print / Save as PDF</button>
              <button className="btn-secondary" style={{ flex: 1, padding: 10 }} onClick={() => setInvoice(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import { api } from '../../../api.js';

/* == page: payments == */

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_PILL = { paid: 'pill-green', pending: 'pill-amber', overdue: 'pill-red', refunded: 'pill' };
const METHOD_PILL = { QRPh: 'pill-blue', Cash: 'pill-teal', Check: 'pill-teal', Unpaid: 'pill' };

export default function Payments({ go, toast, openModal }) {
  const [tab, setTab] = useState('checkout');

  const [payments, setPayments] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = () => {
    setLoading(true);
    Promise.all([api('/payments'), api('/clients')])
      .then(([p, c]) => { setPayments(p || []); setClients(c || []); })
      .catch(() => toast('Failed to load payment data', 'fa-triangle-exclamation'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchAll(); }, []);

  const outstanding = payments.filter(p => p.status === 'pending' || p.status === 'overdue');
  const paid = payments.filter(p => p.status === 'paid');
  const refunded = payments.filter(p => p.status === 'refunded');

  /* ── 11.1–11.3 QRPh checkout: pick a client, pick one outstanding invoice, generate a real QR ── */
  const [selClientId, setSelClientId] = useState('');
  const clientOutstanding = outstanding.filter(p => p.client_id === selClientId);
  const clientsWithBalance = clients.filter(c => outstanding.some(p => p.client_id === c.id));

  const [qrModal, setQrModal] = useState(null); // { payment, image, expiresAt, status }
  const [qrBusy, setQrBusy] = useState(false);

  async function generateQr(payment) {
    setQrBusy(true);
    try {
      const res = await api(`/payments/${payment.id}/qrph`, { method: 'POST' });
      setQrModal({ payment, image: res.qr_image_url, expiresAt: res.expires_at, testUrl: res.test_url, status: 'awaiting_payment' });
    } catch (e) {
      toast(e.message || 'Failed to generate QRPh code', 'fa-triangle-exclamation');
    } finally {
      setQrBusy(false);
    }
  }

  useEffect(() => {
    if (!qrModal || qrModal.status === 'paid') return;
    const iv = setInterval(async () => {
      try {
        const res = await api(`/payments/${qrModal.payment.id}/qrph/status`);
        if (res.status === 'paid') {
          setQrModal(m => (m ? { ...m, status: 'paid' } : m));
          toast('Payment received via QRPh', 'fa-circle-check');
          fetchAll();
        }
      } catch { /* transient poll failure, try again next tick */ }
    }, 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrModal?.payment?.id, qrModal?.status]);

  /* ── 11.7 Counter (manual Cash/Check) payment ── */
  const [otcClientId, setOtcClientId] = useState('');
  const [otcMethod, setOtcMethod] = useState('Cash');
  const otcOutstanding = outstanding.filter(p => p.client_id === otcClientId);

  async function markPaidManually(payment) {
    try {
      await api(`/payments/${payment.id}`, { method: 'PUT', body: { status: 'paid', method: otcMethod } });
      toast(`${otcMethod} payment confirmed, ${payment.invoice_no || payment.id}`, 'fa-receipt');
      fetchAll();
    } catch (e) {
      toast(e.message || 'Failed to record payment', 'fa-triangle-exclamation');
    }
  }

  /* ── Refund (11.9) ── */
  function refund(payment) {
    openModal('refund', {
      paymentId: payment.invoice_no || payment.id,
      invoiceNo: payment.invoice_no,
      amount: payment.amount,
      onSave: async (reason) => {
        try {
          await api(`/payments/${payment.id}/refund`, { method: 'POST', body: { reason } });
          toast(`Refund recorded, ${payment.invoice_no || payment.id}`, 'fa-rotate-left');
          fetchAll();
        } catch (e) {
          toast(e.message || 'Failed to record refund', 'fa-triangle-exclamation');
          return false;
        }
      }
    });
  }

  /* ── 11.8 Real printable invoice (browser print, no PDF lib needed) ── */
  const [invoice, setInvoice] = useState(null);
  function printInvoice() { window.print(); }

  const [methodFilter, setMethodFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const filteredTxns = payments.filter(p => (!methodFilter || p.method === methodFilter) && (!statusFilter || p.status === statusFilter));

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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Payment Management</h1>
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>QRPh checkout (PayMongo), over-the-counter payments, invoices, and transaction sealing, connected to real bookings.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={() => setTab('checkout')}>
            <i className="fa-solid fa-qrcode" style={{ color: '#0EA5E9' }} /> New QRPh Payment
          </button>
          <button className="qa-btn" style={{ width: 'auto', padding: '10px 16px', fontSize: 13 }} onClick={fetchAll}>
            <i className="fa-solid fa-rotate" style={{ color: '#0D9488' }} /> Refresh
          </button>
        </div>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className={'pay-tab' + (tab === 'checkout' ? ' active' : '')} onClick={() => setTab('checkout')}><i className="fa-solid fa-qrcode" style={{ marginRight: 6 }} />QRPh Checkout</button>
        <button className={'pay-tab' + (tab === 'counter' ? ' active' : '')} onClick={() => setTab('counter')}><i className="fa-solid fa-cash-register" style={{ marginRight: 6 }} />Counter Payment</button>
        <button className={'pay-tab' + (tab === 'receipts' ? ' active' : '')} onClick={() => setTab('receipts')}><i className="fa-solid fa-file-invoice" style={{ marginRight: 6 }} />Invoices</button>
        <button className={'pay-tab' + (tab === 'transactions' ? ' active' : '')} onClick={() => setTab('transactions')}><i className="fa-solid fa-table-list" style={{ marginRight: 6 }} />All Transactions</button>
      </div>

      {/* ═══════ QRPh CHECKOUT ═══════ */}
      <div id="tab-checkout" style={{ display: tab === 'checkout' ? '' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 16, marginBottom: 24 }}>
          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-qrcode" style={{ color: '#0EA5E9', marginRight: 7 }} />QRPh Checkout: PayMongo</div>
            <div className="section-sub" style={{ marginBottom: 16 }}>Pick a client, then generate a real QR code for one outstanding invoice. The parent scans with any QRPh-supported bank/e-wallet app.</div>

            <div style={{ marginBottom: 14 }}>
              <label className="form-label">Client with outstanding balance</label>
              <select className="form-select" value={selClientId} onChange={e => setSelClientId(e.target.value)}>
                <option value="">- Select client -</option>
                {clientsWithBalance.map(c => {
                  const bal = outstanding.filter(p => p.client_id === c.id).reduce((s, p) => s + Number(p.amount), 0);
                  return <option key={c.id} value={c.id}>{c.full_name}, {c.client_code} (₱{bal.toLocaleString()} outstanding)</option>;
                })}
              </select>
              {clientsWithBalance.length === 0 && <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 6 }}>No clients currently have an outstanding balance.</div>}
            </div>

            {selClientId && (
              <div style={{ marginBottom: 4 }}>
                <label className="form-label">Outstanding invoices</label>
                <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ background: '#F8FAFC', padding: '8px 14px', borderBottom: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.06em' }}>Invoice</span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.06em' }}>Amount</span>
                  </div>
                  {clientOutstanding.length === 0 && <div style={{ padding: 14, fontSize: 12.5, color: '#94A3B8' }}>This client has no outstanding invoices.</div>}
                  {clientOutstanding.map(p => (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #F1F5F9' }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{p.invoice_no || p.id}</div>
                        <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{fmtDate(p.created_at)} · <span className={'pill ' + STATUS_PILL[p.status]} style={{ fontSize: 9 }}>{p.status}</span></div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>₱{Number(p.amount).toLocaleString()}</span>
                        <button className="btn-primary" style={{ fontSize: 11, padding: '6px 10px' }} disabled={qrBusy} onClick={() => generateQr(p)}>
                          <i className="fa-solid fa-qrcode" style={{ marginRight: 4 }} />Generate QR
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 16, padding: '8px 12px', borderRadius: 8, background: '#F0F9FF', border: '1px solid #BFDBFE', fontSize: 12, color: '#1E40AF' }}>
              <i className="fa-solid fa-shield-halved" style={{ marginRight: 5 }} />
              Codes are generated live via PayMongo's Payment Intent API and confirmed automatically by webhook (or by polling, while running locally without a public webhook URL).
            </div>
          </div>

          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 4 }}>Recently Paid via QRPh</div>
            <div className="section-sub" style={{ marginBottom: 16 }}>Confirmed automatically the moment PayMongo reports payment</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {paid.filter(p => p.method === 'QRPh').length === 0 && <div style={{ fontSize: 12.5, color: '#94A3B8' }}>No QRPh payments confirmed yet.</div>}
              {paid.filter(p => p.method === 'QRPh').slice(0, 6).map(p => (
                <div key={p.id} style={{ padding: '12px 14px', borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{p.invoice_no || p.id}</div><div style={{ fontSize: 12, color: '#64748B' }}>QRPh · Ref: <span style={{ fontFamily: 'monospace' }}>{p.reference}</span> · ₱{Number(p.amount).toLocaleString()}</div></div>
                    <span className="pill pill-green" style={{ fontSize: 10 }}>Paid</span>
                  </div>
                  <button className="btn-edit" style={{ fontSize: 11, marginTop: 8 }} onClick={() => setInvoice(p)}><i className="fa-solid fa-file-invoice" /> View Invoice</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ═══════ COUNTER PAYMENT ═══════ */}
      <div id="tab-counter" style={{ display: tab === 'counter' ? '' : 'none' }}>
        <div className="card" style={{ padding: '22px 20px', maxWidth: 620 }}>
          <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-cash-register" style={{ color: '#10B981', marginRight: 7 }} />Over-the-Counter Payment</div>
          <div className="section-sub" style={{ marginBottom: 16 }}>Record a Cash or Check payment taken in person against a real outstanding invoice</div>
          <div style={{ marginBottom: 14 }}>
            <label className="form-label">Client</label>
            <select className="form-select" value={otcClientId} onChange={e => setOtcClientId(e.target.value)}>
              <option value="">- Select client -</option>
              {clientsWithBalance.map(c => <option key={c.id} value={c.id}>{c.full_name}, {c.client_code}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label className="form-label">Payment Method</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className={'gw-btn' + (otcMethod === 'Cash' ? ' selected' : '')} onClick={() => setOtcMethod('Cash')}><i className="fa-solid fa-money-bill-wave" />Cash</button>
              <button className={'gw-btn' + (otcMethod === 'Check' ? ' selected' : '')} onClick={() => setOtcMethod('Check')}><i className="fa-solid fa-money-check" />Check</button>
            </div>
          </div>
          {otcClientId && (
            <div style={{ border: '1.5px solid #E2E8F0', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ background: '#F8FAFC', padding: '8px 14px', borderBottom: '1px solid #E2E8F0', fontSize: 11.5, fontWeight: 600, color: '#64748B', textTransform: 'uppercase', letterSpacing: '.06em' }}>Outstanding Invoices</div>
              {otcOutstanding.length === 0 && <div style={{ padding: 14, fontSize: 12.5, color: '#94A3B8' }}>This client has no outstanding invoices.</div>}
              {otcOutstanding.map(p => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #F1F5F9' }}>
                  <div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{p.invoice_no || p.id}</div><div style={{ fontSize: 11.5, color: '#94A3B8' }}>{fmtDate(p.created_at)}</div></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>₱{Number(p.amount).toLocaleString()}</span>
                    <button className="btn-primary" style={{ fontSize: 11, padding: '6px 10px', background: '#10B981', borderColor: '#10B981' }} onClick={() => markPaidManually(p)}>
                      <i className="fa-solid fa-check" style={{ marginRight: 4 }} />Confirm {otcMethod}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ═══════ INVOICES ═══════ */}
      <div id="tab-receipts" style={{ display: tab === 'receipts' ? '' : 'none' }}>
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9' }}><div className="section-title">Billing Invoices</div><div className="section-sub">Every invoice ever generated, auto-created on booking confirmation, or recorded manually</div></div>
          <div style={{ overflowX: 'auto' }}><table className="data-table">
            <thead><tr><th style={{ paddingLeft: 24 }}>Invoice No.</th><th>Client</th><th>Method</th><th>Reference</th><th>Amount</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>Loading…</td></tr>}
              {!loading && payments.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>No invoices yet</td></tr>}
              {!loading && payments.map(p => (
                <tr key={p.id}>
                  <td style={{ paddingLeft: 24, fontWeight: 600, fontSize: 12.5 }}>{p.invoice_no || '-'}</td>
                  <td><div style={{ fontWeight: 600 }}>{p.clients?.full_name || '-'}</div><div style={{ fontSize: 11, color: '#94A3B8' }}>{p.clients?.guardian_name || ''}</div></td>
                  <td><span className={'pill ' + (METHOD_PILL[p.method] || 'pill')} style={{ fontSize: 10 }}>{p.method}</span></td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: '#0284C7' }}>{p.reference || '-'}</td>
                  <td style={{ fontWeight: 700, color: '#059669' }}>₱{Number(p.amount).toLocaleString()}</td>
                  <td style={{ fontSize: 12.5 }}>{fmtDate(p.created_at)}</td>
                  <td><span className={'pill ' + STATUS_PILL[p.status]} style={{ fontSize: 10 }}>{p.status}</span></td>
                  <td style={{ textAlign: 'right', paddingRight: 24 }}><button className="btn-edit" style={{ fontSize: 11 }} onClick={() => setInvoice(p)}><i className="fa-solid fa-file-invoice" /> View</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      </div>

      {/* ═══════ ALL TRANSACTIONS + SEAL ═══════ */}
      <div id="tab-transactions" style={{ display: tab === 'transactions' ? '' : 'none' }}>
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div><div className="section-title">All Transactions</div><div className="section-sub">Full payment record</div></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">All Status</option><option value="paid">Paid</option><option value="pending">Pending</option><option value="overdue">Overdue</option><option value="refunded">Refunded</option>
              </select>
              <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={methodFilter} onChange={e => setMethodFilter(e.target.value)}>
                <option value="">All Methods</option><option value="QRPh">QRPh</option><option value="Cash">Cash</option><option value="Check">Check</option><option value="Unpaid">Unpaid</option>
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}><table className="data-table">
            <thead><tr><th style={{ paddingLeft: 24 }}>Invoice</th><th>Client</th><th>Method</th><th>Amount</th><th>Date</th><th>Status</th><th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>Loading…</td></tr>}
              {!loading && filteredTxns.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, fontSize: 12.5, color: '#94A3B8' }}>No transactions match these filters</td></tr>}
              {!loading && filteredTxns.map(p => (
                <tr key={p.id}>
                  <td style={{ paddingLeft: 24, fontSize: 12, fontWeight: 600, color: '#64748B' }}>{p.invoice_no || p.id.slice(0, 8)}</td>
                  <td><div style={{ fontWeight: 600 }}>{p.clients?.full_name || '-'}</div></td>
                  <td><span className={'pill ' + (METHOD_PILL[p.method] || 'pill')} style={{ fontSize: 10 }}>{p.method}</span></td>
                  <td style={{ fontWeight: 700, color: p.status === 'refunded' ? '#B45309' : '#059669' }}>₱{Number(p.amount).toLocaleString()}</td>
                  <td style={{ fontSize: 12.5 }}>{fmtDate(p.created_at)}</td>
                  <td><span className={'pill ' + STATUS_PILL[p.status]}>{p.status}</span></td>
                  <td style={{ textAlign: 'right', paddingRight: 24 }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => setInvoice(p)}><i className="fa-solid fa-file-invoice" /></button>
                      {p.status === 'paid' && <button className="btn-danger" style={{ fontSize: 11 }} onClick={() => refund(p)}>Refund</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Secure Payment Checkout</span></div>

      {/* ── QRPh modal ── */}
      {qrModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setQrModal(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 360, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>{qrModal.payment.invoice_no || qrModal.payment.id}</div>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>₱{Number(qrModal.payment.amount).toLocaleString()}</div>
            {qrModal.status === 'paid' ? (
              <div style={{ padding: '32px 0' }}>
                <i className="fa-solid fa-circle-check" style={{ fontSize: 48, color: '#10B981', marginBottom: 12 }} />
                <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>Payment Received</div>
              </div>
            ) : qrModal.image ? (
              <>
                <img src={qrModal.image} alt="QRPh code" style={{ width: 240, height: 240, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 10 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Waiting for payment, scan with any QRPh app</div>
                <div style={{ fontSize: 11, color: '#CBD5E1', marginTop: 4 }}>Expires {new Date(qrModal.expiresAt).toLocaleTimeString()}</div>
                {qrModal.testUrl && (
                  <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, background: '#FFFBEB', border: '1px solid #FDE68A', textAlign: 'left' }}>
                    <div style={{ fontSize: 11, color: '#92400E', marginBottom: 6 }}><i className="fa-solid fa-flask" style={{ marginRight: 5 }} />Sandbox mode, do not scan this code with a real app.</div>
                    <a href={qrModal.testUrl} target="_blank" rel="noreferrer" className="btn-primary" style={{ display: 'block', textAlign: 'center', padding: 8, fontSize: 12, textDecoration: 'none' }}>
                      Simulate Payment (Test Mode)
                    </a>
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '24px 0' }}>Generating QR code…</div>
            )}
            <button className="btn-secondary" style={{ width: '100%', marginTop: 16 }} onClick={() => setQrModal(null)}>Close</button>
          </div>
        </div>
      )}

      {/* ── Printable invoice modal ── */}
      {invoice && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setInvoice(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 0, width: 520, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div id="invoice-print" style={{ padding: 28, fontFamily: "'Inter',Arial,sans-serif" }}>
              {/* Letterhead */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingBottom: 18, borderBottom: '3px solid #1F4E9E' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 46, height: 46, borderRadius: 10, background: 'linear-gradient(135deg,#1F4E9E,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <i className="fa-solid fa-child-reaching" style={{ color: '#fff', fontSize: 19 }} />
                  </div>
                  <div>
                    <div style={{ fontFamily: "'Poppins',sans-serif", fontSize: 18, fontWeight: 700, color: '#0F172A', lineHeight: 1.2 }}>Bloomsdale Therapy Center</div>
                    <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>Pediatric Speech &amp; Occupational Therapy</div>
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>Imus, Cavite, Philippines</div>
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
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>Bloomsdale Therapy Center</div>
                  <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>Imus, Cavite, Philippines</div>
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
                    <span style={{ fontFamily: "'Poppins',sans-serif", fontSize: 17, fontWeight: 700, color: '#10B981' }}>₱{Number(invoice.amount).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* Payment details */}
              <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid #E2E8F0' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Payment Details</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
                  <div><span style={{ color: '#64748B' }}>Method: </span><span style={{ fontWeight: 600 }}>{invoice.method}</span></div>
                  <div><span style={{ color: '#64748B' }}>Reference: </span><span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#0284C7' }}>{invoice.reference || '-'}</span></div>
                  {invoice.paid_at && <div><span style={{ color: '#64748B' }}>Paid At: </span><span style={{ fontWeight: 600 }}>{fmtDate(invoice.paid_at)}</span></div>}
                </div>
              </div>

              {/* Footer note */}
              <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid #E2E8F0', textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: '#475569', fontWeight: 600 }}>Thank you for trusting Bloomsdale Therapy Center with your child's care.</div>
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

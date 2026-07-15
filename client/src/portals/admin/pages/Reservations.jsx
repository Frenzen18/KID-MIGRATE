import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { LoadingState, TableEmptyRow } from '../../../components/ui.jsx';
import BookingModal from './reservations/BookingModal.jsx';
import SlotActionsModal from './reservations/SlotActionsModal.jsx';
import DeclineModal from './reservations/DeclineModal.jsx';
import ApproveModal from './reservations/ApproveModal.jsx';
import {
  pad, fmtYMD, todayPH, nowPH, DAY_NAMES, CAL_MONTH_NAMES, MON_SHORT, SESSION_MIN,
  defaultSessionTypeFor, rateForSessionType, STATUS_PILL, slotMinutes, toMinutes,
  computeSelection, fmtShort
} from './reservations/reservationsHelpers.js';

/* == page: reservations (real data via /api/reservations + /api/clients) == */
/* Shared helpers, and the 4 page-local modal components (BookingModal,
   SlotActionsModal, DeclineModal, ApproveModal), now live under ./reservations/
  , this file keeps only the page component itself: state, data fetching,
   and the tab views (calendar / queue / master calendar / parent requests). */

export default function Reservations({ toast }) {
  /* ── Section tabs ── */
  const [tab, setTab] = useState('calendar');

  /* ── Calendar view (0-indexed month) ── */
  const [calView, setCalView] = useState(() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; });

  /* ── Selected day, auto-select today (PH time) on load ── */
  const [selected, setSelected] = useState(() => computeSelection(todayPH()));

  /* ── Page-local modal state ── */
  const [modal, setModal] = useState(null);
  const closeModal = () => setModal(null);

  /* ══════════ Real data state ══════════ */
  const [clients, setClients] = useState([]);
  const [reservations, setReservations] = useState([]); // all reservations in the visible range (month + slack)
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /* Fetch the client list once. */
  useEffect(() => {
    api('/clients').then(setClients).catch(err => {
      setClients([]);
      toast('Failed to load clients: ' + err.message, 'fa-triangle-exclamation');
    });
  }, [toast]);

  /* Shift-driven slot availability for the selected day. */
  const [daySlots, setDaySlots] = useState([]);
  const daySlotsReqRef = useRef(0);
  async function refetchDaySlots(date) {
    const reqId = ++daySlotsReqRef.current;
    try {
      const data = await api('/reservations/slots?date=' + (date || selected.date));
      // Ignore this response if a newer request has since been kicked off, 
      // prevents an older/slower poll from overwriting fresher data and
      // causing the "pops up then disappears" flicker.
      if (reqId === daySlotsReqRef.current) setDaySlots(data);
    } catch {
      // Transient failure (network blip/abort), keep showing the last known
      // good slots instead of clearing them, so nothing flickers to empty.
    }
  }
  useEffect(() => {
    refetchDaySlots(selected.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.date]);

  const slotByTime = t => daySlots.find(s => s.time_slot === t);
  const slotAvailable = t => (slotByTime(t)?.available ?? 0) > 0;

  /* Fetch a wide window of reservations (covers the visible month + a buffer)
     so the mini-calendar dots, master calendar, and Adjust/Cancel table all
     have real data without a separate request per view. */
  const reservationsReqRef = useRef(0);
  async function refetchReservations(silent) {
    const from = fmtYMD(new Date(calView.y, calView.m - 1, 1));
    const to = fmtYMD(new Date(calView.y, calView.m + 2, 0));
    const reqId = ++reservationsReqRef.current;
    try {
      const data = await api('/reservations?from=' + from + '&to=' + to);
      // Drop stale responses (e.g. an earlier poll that resolves after a
      // newer one) so background refreshes never clobber fresher data.
      if (reqId !== reservationsReqRef.current) return;
      setReservations(data || []);
      refetchDaySlots(); // keep slot capacities in sync with bookings
    } catch (e) {
      if (reqId !== reservationsReqRef.current) return;
      // Background polls stay quiet on transient failures (e.g. a dropped
      // request) instead of popping an error toast every 30s.
      if (!silent) toast(e.message || 'Failed to load reservations', 'fa-circle-exclamation');
    }
  }
  useEffect(() => {
    setLoading(true);
    refetchReservations().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calView.y, calView.m]);

  /* Live ticker: re-check "ended/ongoing/future" slot states as the clock moves,
     and periodically refresh from the server so multi-user changes show up. */
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => {
      setTick(t => t + 1);
      refetchReservations(true);
    }, 30000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calView.y, calView.m]);

  const todayISO = todayPH();

  /* Map of date|time -> ACTIVE reservations (a slot can hold several, one per on-shift therapist) */
  const slotMap = useMemo(() => {
    const m = {};
    reservations.forEach(r => {
      if (r.status === 'cancelled' || r.status === 'declined') return;
      (m[r.date + '|' + r.time_slot] = m[r.date + '|' + r.time_slot] || []).push(r);
    });
    return m;
  }, [reservations]);

  const slotKey = t => selected.date + '|' + t;

  /* State of a time slot on the currently selected date: 'future' | 'ongoing' | 'ended' */
  function slotState(time) {
    if (selected.isPast) return 'ended';
    if (selected.date !== todayISO) return 'future';
    const mins = slotMinutes(time);
    if (mins == null) return 'future';
    const now = nowPH();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (nowMin >= mins + SESSION_MIN) return 'ended';
    if (nowMin >= mins) return 'ongoing';
    return 'future';
  }

  function clientLabel(c) { return (c.full_name || '') + ', ' + (c.client_code || ''); }
  function findClientByLabel(label) {
    return clients.find(c => clientLabel(c) === label);
  }

  /* ══════════ Calendar day select ══════════ */
  function selectDay(dateStr) {
    const sel = computeSelection(dateStr);
    setSelected(sel);
    toast(sel.isPast ? sel.label + ', sessions ended' : 'Viewing ' + sel.label, sel.isPast ? 'fa-lock' : 'fa-calendar-day');
  }

  function changeMonth(dir) {
    setCalView(v => {
      let m = v.m + dir, y = v.y;
      if (m > 11) { m = 0; y++; }
      if (m < 0) { m = 11; y--; }
      toast('Viewing ' + CAL_MONTH_NAMES[m] + ' ' + y, 'fa-calendar');
      return { y, m };
    });
  }

  /* ── Book Selected Day button ── */
  function bookSelectedDay() {
    if (selected.isPast) { toast('Cannot book, this date has already passed', 'fa-lock'); return; }
    openBookingModal(null);
  }

  /* ══════════ Booking modal ══════════ */
  function openBookingModal(time) {
    if (time && !slotAvailable(time)) return; // fully booked
    if (time && slotState(time) !== 'future') {
      toast('That time has already passed, the session has ' + (slotState(time) === 'ongoing' ? 'already started' : 'ended'), 'fa-clock');
      return;
    }
    const bookable = t => slotAvailable(t) && slotState(t) === 'future';
    const times = daySlots.map(s => s.time_slot);
    if (!times.some(bookable)) {
      toast('No more available time slots for this day', 'fa-circle-exclamation');
      return;
    }
    const defaultTime = (time && bookable(time)) ? time : times.find(bookable);
    setModal({ kind: 'booking', time: time || null, defaultTime });
  }

  async function confirmBooking() {
    const timeSelect = document.getElementById('modal-time-select');
    const clientSelect = document.getElementById('modal-client-select');
    const bookedTime = timeSelect ? timeSelect.value : '';
    const clientVal = clientSelect ? clientSelect.value : '';
    const bkErr = msg => {
      const box = document.getElementById('bk-err');
      if (box) { document.getElementById('bk-err-msg').textContent = msg; box.style.display = 'block'; }
      toast(msg, 'fa-circle-exclamation');
    };
    if (!bookedTime) { bkErr('Pick a time slot first.'); if (timeSelect) timeSelect.style.borderColor = '#EF4444'; return; }
    if (!slotAvailable(bookedTime)) { bkErr('That time is fully booked, choose a different slot.'); if (timeSelect) timeSelect.style.borderColor = '#EF4444'; return; }
    if (slotState(bookedTime) !== 'future') { bkErr('That time has already passed today, pick a later slot.'); if (timeSelect) timeSelect.style.borderColor = '#EF4444'; return; }
    const client = findClientByLabel(clientVal);
    if (!client) { bkErr('Select a client first, then confirm.'); if (clientSelect) { clientSelect.style.borderColor = '#EF4444'; clientSelect.focus(); } return; }

    const notesVal = document.getElementById('modal-notes')?.value || '';
    const amountEl = document.getElementById('modal-amount');
    const amountVal = Number(amountEl?.value);
    if (!Number.isFinite(amountVal) || amountVal <= 0) { bkErr('Enter a valid payment amount.'); if (amountEl) { amountEl.style.borderColor = '#EF4444'; amountEl.focus(); } return; }

    setBusy(true);
    try {
      await api('/reservations', {
        method: 'POST',
        body: {
          client_id: client.id,
          date: selected.date,
          time_slot: bookedTime,
          session_type: defaultSessionTypeFor(client),
          notes: notesVal,
          payment_amount: amountVal
        }
      });
      closeModal();
      await refetchReservations();
      toast('Booking confirmed, ' + selected.label + ' · ' + bookedTime, 'fa-calendar-check');
    } catch (e) {
      bkErr(e.message || 'Failed to create booking');
    } finally {
      setBusy(false);
    }
  }

  /* ══════════ Slot actions modal (reschedule / cancel) ══════════ */
  function openSlotActions(time, reservation) {
    const bk = reservation || (slotMap[slotKey(time)] || [])[0];
    if (!bk) return;
    setModal({ kind: 'slot', time, reservation: bk });
  }

  async function cancelSlot(reservationId) {
    setBusy(true);
    try {
      await api('/reservations/' + reservationId, { method: 'PUT', body: { status: 'cancelled' } });
      closeModal();
      await refetchReservations();
      toast('Booking cancelled, slot is now available', 'fa-calendar-xmark');
    } catch (e) {
      toast(e.message || 'Failed to cancel booking', 'fa-circle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  async function noShowSlot(reservationId) {
    setBusy(true);
    try {
      await api('/reservations/' + reservationId, { method: 'PUT', body: { status: 'no_show' } });
      closeModal();
      await refetchReservations();
      toast('Client marked as no-show', 'fa-user-slash');
    } catch (e) {
      toast(e.message || 'Failed to mark as no-show', 'fa-circle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  async function rescheduleSlot(reservationId, oldTime) {
    const sel = document.getElementById('reschedule-new-time');
    const newTime = sel ? sel.value.trim() : '';
    if (!newTime || newTime === oldTime) { toast('Pick a different time slot to reschedule to', 'fa-circle-exclamation'); return; }
    setBusy(true);
    try {
      await api('/reservations/' + reservationId, { method: 'PUT', body: { date: selected.date, time_slot: newTime } });
      closeModal();
      await refetchReservations();
      toast('Rescheduled ' + oldTime + ' → ' + newTime, 'fa-arrows-rotate');
    } catch (e) {
      toast(e.message || 'Failed to reschedule', 'fa-circle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  /** Opens the slot-actions modal for a row from the Adjust & Cancel table, first points
   *  `selected` at that booking's own date, since the modal's reschedule options are computed
   *  from `daySlots`, which is fetched for whatever day is currently selected on the Calendar tab. */
  function manageBookingFromQueue(r) {
    setSelected(computeSelection(r.date));
    openSlotActions(r.time_slot, r);
  }

  async function saveAmount(paymentId, newAmount) {
    const amt = Number(newAmount);
    if (!Number.isFinite(amt) || amt <= 0) { toast('Enter a valid amount', 'fa-circle-exclamation'); return; }
    setBusy(true);
    try {
      await api('/payments/' + paymentId, { method: 'PUT', body: { amount: amt } });
      await refetchReservations();
      toast('Invoice amount updated', 'fa-peso-sign');
    } catch (e) {
      toast(e.message || 'Failed to update amount', 'fa-circle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  /* ══════════ Adjust & Cancel Schedules table ══════════ */
  const [statusFilter, setStatusFilter] = useState('all');

  /* ══════════ Parent request queue ══════════ */
  const pendingRequests = useMemo(() => reservations.filter(r => r.status === 'pending'), [reservations]);

  /** Used only by "Approve All Clear" (bulk), individual approvals go through
   *  ApproveModal so staff can see and set the price first. */
  async function approveParentRequest(r) {
    setBusy(true);
    try {
      await api('/reservations/' + r.id, { method: 'PUT', body: { status: 'confirmed' } });
      await refetchReservations();
      toast((r.clients?.full_name || 'Request') + ' booking approved and synced to calendar', 'fa-circle-check');
    } catch (e) {
      toast(e.message || 'Cannot approve, slot may already be booked', 'fa-circle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  function openApproveModal(r) { setModal({ kind: 'approve', reservation: r }); }

  async function confirmApproveRequest(r, amount) {
    setBusy(true);
    try {
      await api('/reservations/' + r.id, { method: 'PUT', body: { status: 'confirmed', payment_amount: amount } });
      closeModal();
      await refetchReservations();
      toast((r.clients?.full_name || 'Request') + ' booking approved and synced to calendar', 'fa-circle-check');
    } catch (e) {
      toast(e.message || 'Cannot approve, slot may already be booked', 'fa-circle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  function openDeclineModal(r) { setModal({ kind: 'decline', reservation: r }); }

  async function confirmDecline(r, reason) {
    setBusy(true);
    try {
      await api('/reservations/' + r.id, { method: 'PUT', body: { status: 'declined', notes: (reason || '').trim() || 'No reason provided' } });
      closeModal();
      await refetchReservations();
      toast((r.clients?.full_name || 'Request') + ' declined', 'fa-circle-xmark');
    } catch (e) {
      toast(e.message || 'Failed to decline request', 'fa-circle-exclamation');
    } finally {
      setBusy(false);
    }
  }

  async function approveAllClear() {
    if (!pendingRequests.length) { toast('No pending requests to approve', 'fa-circle-info'); return; }
    setBusy(true);
    let approvedCount = 0;
    for (const r of pendingRequests) {
      try {
        await api('/reservations/' + r.id, { method: 'PUT', body: { status: 'confirmed' } });
        approvedCount++;
      } catch (e) { /* slot conflict or similar, skip and continue */ }
    }
    await refetchReservations();
    setBusy(false);
    if (approvedCount > 0) toast(approvedCount + ' pending request(s) approved and synced', 'fa-circle-check');
    else toast('Could not approve pending requests, check for slot conflicts', 'fa-triangle-exclamation');
  }

  /* ══════════ Live clock (PH time) ══════════ */
  const liveClock = (() => {
    const now = nowPH();
    let h = now.getUTCHours();
    const mi = String(now.getUTCMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + mi + ' ' + ap;
  })();

  /* ══════════ Calendar grid cells ══════════ */
  function renderCalCells() {
    const { y: year, m: month } = calView;
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev = new Date(year, month, 0).getDate();
    const cells = [];

    const makeCell = (day, monthIdx, isOther) => {
      const dateStr = year + '-' + pad(monthIdx + 1) + '-' + pad(day);
      const isPast = dateStr < todayPH();
      const isToday = dateStr === todayPH();
      const hasEvent = reservations.some(r => r.date === dateStr && r.status !== 'cancelled' && r.status !== 'declined');
      const isSelected = dateStr === selected.date;
      const cls = 'cal-cell'
        + (isOther ? ' other' : '')
        + (isPast ? ' past' : '')
        + (isToday ? ' today' : '')
        + (hasEvent ? ' has-event' : '')
        + (isSelected ? ' selected' : '');
      return { key: (isOther ? 'o' : 'c') + '-' + dateStr + '-' + day, cls, day, dateStr };
    };

    for (let i = firstDay - 1; i >= 0; i--) cells.push(makeCell(daysInPrev - i, month - 1, true));
    for (let d = 1; d <= daysInMonth; d++) cells.push(makeCell(d, month, false));
    const total = firstDay + daysInMonth;
    const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let d = 1; d <= trailing; d++) cells.push(makeCell(d, month + 1, true));

    return cells.map(c => (
      <div key={c.key} className={c.cls} data-date={c.dateStr} onClick={() => selectDay(c.dateStr)}>{c.day}</div>
    ));
  }

  /* ══════════ Day-view time slots (from therapist shifts) ══════════ */
  function renderDaySlots() {
    if (!daySlots.length) {
      return (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: '#94A3B8', fontSize: 12.5 }}>
          No time slots for this day, no therapists are on shift. Set shifts in Client Records → Employee Scheduling.
        </div>
      );
    }
    return daySlots.map(slot => {
      const time = slot.time_slot;
      const bks = slot.reservations || [];
      const openCount = Math.max(0, slot.capacity - bks.length);

      const bookedBlock = (bk, extra) => {
        const client = bk.clients?.full_name || '-';
        const statusInfo = STATUS_PILL[bk.status] || STATUS_PILL.pending;
        return (
          <div key={bk.id} className="slot-block" style={{ background: '#DCFCE7', color: '#166534', borderLeft: '3px solid #16A34A', cursor: extra?.locked ? 'not-allowed' : 'pointer', ...(extra?.dim ? { opacity: 0.55, pointerEvents: 'none' } : {}) }} onClick={extra?.locked ? undefined : () => openSlotActions(time, bk)}>
            <i className="fa-solid fa-calendar-check" style={{ marginRight: 6, fontSize: 10 }} />
            <strong>{client}</strong>
            {bk.duration_min ? ' · ' + bk.duration_min + ' minutes' : ''}
            {bk.therapist_name ? ' · ' + bk.therapist_name : ''}
            {bk.room ? ' · ' + bk.room : ''}
            {bk.status !== 'confirmed' && <span style={{ fontSize: 10, background: '#FEF9C3', color: '#B45309', borderRadius: 5, padding: '1px 7px', marginLeft: 6, fontWeight: 700 }}>{statusInfo.label.toUpperCase()}</span>}
            <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 8 }}>click to reschedule / cancel</span>
            {extra?.ongoing && <span style={{ fontSize: 10, background: '#FEF9C3', color: '#B45309', borderRadius: 5, padding: '1px 7px', marginLeft: 6, fontWeight: 700 }}>ONGOING NOW</span>}
          </div>
        );
      };
      const emptyBlock = () => (
        <div className="slot-block empty" key="empty" onClick={() => openBookingModal(time)}>
          + Click to book this slot{slot.capacity > 1 ? ` · ${openCount} of ${slot.capacity} therapists free` : ''}
        </div>
      );
      const lockedEmpty = (label) => (
        <div className="slot-block empty" key="locked" style={{ opacity: 0.5, pointerEvents: 'none', cursor: 'not-allowed' }}>
          <i className="fa-solid fa-lock" style={{ marginRight: 5, fontSize: 10 }} />{label}
        </div>
      );

      const blocks = [];
      if (selected.isPast) {
        bks.forEach(bk => blocks.push(bookedBlock(bk, { locked: true, dim: true })));
        if (!bks.length) blocks.push(lockedEmpty('Session ended'));
      } else if (selected.date === todayISO) {
        const st = slotState(time);
        if (st === 'ended') {
          bks.forEach(bk => blocks.push(
            <div key={bk.id} className="slot-block" style={{ background: '#DCFCE7', color: '#166534', borderLeft: '3px solid #16A34A', cursor: 'not-allowed', opacity: 0.55, pointerEvents: 'none' }}>
              <i className="fa-solid fa-circle-check" style={{ marginRight: 6, fontSize: 10 }} />{bk.clients?.full_name || '-'} · {time} <span style={{ fontSize: 10, opacity: 0.65, marginLeft: 8 }}>session completed</span>
            </div>
          ));
          if (!bks.length) blocks.push(lockedEmpty('Session ended, ' + time + ' has passed'));
        } else if (st === 'ongoing') {
          bks.forEach(bk => blocks.push(bookedBlock(bk, { ongoing: true })));
          if (!bks.length) blocks.push(
            <div key="ongoing" className="slot-block empty" style={{ cursor: 'not-allowed', pointerEvents: 'none', background: '#FEF9C3', color: '#B45309', border: 'none', borderLeft: '3px solid #F59E0B', fontWeight: 600 }}>
              <i className="fa-solid fa-hourglass-half" style={{ marginRight: 6, fontSize: 10 }} />In progress, this slot started at {time}
            </div>
          );
        } else {
          bks.forEach(bk => blocks.push(bookedBlock(bk)));
          if (openCount > 0) blocks.push(emptyBlock());
        }
      } else {
        bks.forEach(bk => blocks.push(bookedBlock(bk)));
        if (openCount > 0) blocks.push(emptyBlock());
      }

      return (
        <div className="slot-row" key={time}>
          <div className="slot-time">{time}</div>
          <div className="slot-area">{blocks}</div>
        </div>
      );
    });
  }

  /* ══════════ Adjust & Cancel Schedules table ══════════ */
  function renderResTable() {
    const filtered = reservations
      .filter(r => statusFilter === 'all' || r.status === statusFilter)
      .slice()
      .sort((a, b) => (a.date + a.time_slot).localeCompare(b.date + b.time_slot));

    if (!filtered.length) {
      return {
        rows: <TableEmptyRow colSpan="7" label="No bookings found for this filter" />,
        count: 'No bookings found'
      };
    }
    const TERMINAL_STATUSES = ['cancelled', 'declined', 'completed', 'no_show'];
    const rows = filtered.map(r => {
      const dateLabel = fmtShort(r.date);
      const typePill = /speech/i.test(r.session_type || '') ? 'pill-teal' : 'pill-blue';
      const st = STATUS_PILL[r.status] || STATUS_PILL.pending;
      const invoice = r.payments?.[0];
      return (
        <tr key={r.id}>
          <td style={{ paddingLeft: 24 }}>
            <div style={{ fontWeight: 600 }}>{r.clients?.full_name || '-'}</div>
            <div style={{ fontSize: 11, color: '#94A3B8' }}>{r.clients?.client_code || ''} · {r.duration_min || 60} min</div>
          </td>
          <td style={{ fontSize: 12.5, fontWeight: 500 }}>{dateLabel} · {r.time_slot}</td>
          <td><span className={'pill ' + typePill} style={{ fontSize: 11 }}>{r.session_type}</span></td>
          <td style={{ fontSize: 12.5 }}>{r.therapist_name || '-'}</td>
          <td style={{ fontSize: 12.5, fontWeight: 600 }}>{invoice ? '₱' + Number(invoice.amount).toLocaleString() : '-'}</td>
          <td>{<span className={'pill ' + st.cls}>{st.label}</span>}</td>
          <td style={{ textAlign: 'right', paddingRight: 24 }}>
            {TERMINAL_STATUSES.includes(r.status)
              ? <span style={{ fontSize: 12, color: '#CBD5E1' }}>-</span>
              : <button className="btn-edit" onClick={() => manageBookingFromQueue(r)}><i className="fa-solid fa-sliders" style={{ marginRight: 4 }} />Manage</button>}
          </td>
        </tr>
      );
    });
    return { rows, count: `Showing ${filtered.length} booking${filtered.length === 1 ? '' : 's'}` };
  }

  /* ══════════ Master calendar (weekly grid) ══════════ */
  function renderMasterCal() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((dayOfWeek === 0 ? 7 : dayOfWeek) - 1));
    const weekDays = [];
    for (let i = 0; i < 7; i++) { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); weekDays.push(d); }

    const dateStr = d => fmtYMD(d);
    const dayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const timeSlots = daySlots.map(s => s.time_slot);

    const header = (
      <tr style={{ background: '#F8FAFC' }}>
        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#64748B', fontWeight: 600, borderBottom: '2px solid #E2E8F0', width: 110 }}>Time</th>
        {weekDays.map((d, i) => {
          const isToday = dateStr(d) === dateStr(today);
          const label = dayShort[i] + ' ' + d.getDate();
          return isToday
            ? <th key={i} style={{ padding: '10px 8px', textAlign: 'center', color: '#0EA5E9', fontWeight: 700, borderBottom: '2px solid #0EA5E9', background: '#F0F9FF' }}>{label} ◀ Today</th>
            : <th key={i} style={{ padding: '10px 8px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '2px solid #E2E8F0' }}>{label}</th>;
        })}
      </tr>
    );

    const body = timeSlots.map(time => (
      <tr key={time} style={{ borderBottom: '1px solid #F1F5F9' }}>
        <td style={{ padding: '10px 12px', color: '#94A3B8', fontWeight: 500 }}>{time}</td>
        {weekDays.map((d, i) => {
          const isToday = dateStr(d) === dateStr(today);
          const cellBg = isToday ? { background: '#F0F9FF' } : {};
          const bks = slotMap[dateStr(d) + '|' + time] || [];
          if (bks.length) {
            return (
              <td key={i} style={{ padding: '6px 4px', textAlign: 'center', ...cellBg }}>
                {bks.map(bk => {
                  const client = bk.clients?.full_name || '-';
                  const type = bk.session_type || '';
                  const isOT = /occupational|OT/i.test(type);
                  const isSpeech = /speech/i.test(type);
                  const pending = bk.status === 'pending';
                  const blockBg = pending ? '#FEF9C3' : (isSpeech ? '#CCFBF1' : '#DBEAFE');
                  const blockColor = pending ? '#B45309' : (isSpeech ? '#0F766E' : '#1D4ED8');
                  const therapistShort = bk.therapist_name ? bk.therapist_name.split(' ').map((w, idx) => idx === 0 ? w[0] + '.' : w).join(' ') : '';
                  const meta = pending ? 'Pending' : [therapistShort, bk.room].filter(Boolean).join('·');
                  const typeAbbr = isSpeech ? 'Sp' : (isOT ? 'OT' : (type ? type.substring(0, 4) : ''));
                  return (
                    <div key={bk.id} style={{ background: blockBg, color: blockColor, borderRadius: 6, padding: '4px 6px', fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
                      {pending ? '⏳ ' : ''}{client.split(' ')[0]}, {typeAbbr}<br /><span style={{ fontWeight: 400 }}>{meta}</span>
                    </div>
                  );
                })}
              </td>
            );
          }
          return <td key={i} style={{ padding: '6px 4px', ...cellBg }} />;
        })}
      </tr>
    ));

    const weekLabel = MON_SHORT[weekStart.getMonth()] + ' ' + weekStart.getDate() + ' – ' + MON_SHORT[weekDays[6].getMonth()] + ' ' + weekDays[6].getDate() + ', ' + weekDays[6].getFullYear();
    const weekSelLabel = 'Week of ' + MON_SHORT[weekStart.getMonth()] + ' ' + weekStart.getDate();

    return { header, body, weekLabel, weekSelLabel };
  }

  /* ══════════ Parent request queue ══════════ */
  function renderParentQueue() {
    if (!pendingRequests.length) {
      return <div style={{ fontSize: 12.5, color: '#94A3B8', textAlign: 'center', padding: '20px 0' }}><i className="fa-solid fa-inbox" style={{ marginRight: 7 }} />No pending parent requests right now</div>;
    }
    return pendingRequests.map(r => {
      const dateLabel = fmtShort(r.date) + ' · ' + r.time_slot;
      return (
        <div key={r.id} style={{ padding: 14, borderRadius: 10, background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{r.clients?.full_name || '-'}, {dateLabel}</div>
              <div style={{ fontSize: 12, color: '#64748B' }}>{r.session_type} · {r.clients?.client_code || ''} · via Parent Portal</div>
            </div>
            <span className="pill pill-amber" style={{ fontSize: 10, flexShrink: 0 }}>Pending</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn-edit" style={{ fontSize: 11, color: '#16A34A', background: '#F0FDF4', borderColor: '#DCFCE7' }} disabled={busy} onClick={() => openApproveModal(r)}>✓ Approve</button>
            <button className="btn-danger" style={{ fontSize: 11 }} disabled={busy} onClick={() => openDeclineModal(r)}>✗ Decline</button>
          </div>
        </div>
      );
    });
  }

  const resTable = renderResTable();
  const master = renderMasterCal();

  return (
    <div className="spa-page" id="spa-reservations">
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Booking and Appointment</h1>
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Interactive booking calendar, real-time scheduling, and synchronized adjustments/cancellations.</p>
        </div>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className={'res-tab' + (tab === 'calendar' ? ' active' : '')} onClick={() => setTab('calendar')}><i className="fa-solid fa-calendar-days" style={{ marginRight: 6 }} />Schedule Session</button>
        <button className={'res-tab' + (tab === 'queue' ? ' active' : '')} onClick={() => setTab('queue')}><i className="fa-solid fa-list-check" style={{ marginRight: 6 }} />Adjust &amp; Cancel Schedules</button>
        <button className={'res-tab' + (tab === 'mastercal' ? ' active' : '')} onClick={() => setTab('mastercal')}><i className="fa-solid fa-table-cells-large" style={{ marginRight: 6 }} />Master Calendar</button>
        <button className={'res-tab' + (tab === 'parentqueue' ? ' active' : '')} onClick={() => setTab('parentqueue')}><i className="fa-solid fa-inbox" style={{ marginRight: 6 }} />Parent Requests <span style={{ display: pendingRequests.length > 0 ? 'inline-flex' : 'none', alignItems: 'center', justifyContent: 'center', background: '#EF4444', color: '#fff', borderRadius: 20, fontSize: 10, fontWeight: 700, minWidth: 18, height: 18, padding: '0 5px', marginLeft: 6 }}>{pendingRequests.length}</span></button>
      </div>

      {loading && <LoadingState label="Loading reservations…" />}

      {!loading && (
      <>
      {/* ═══════ INTERACTIVE RESERVATION BOOKING CALENDAR ═══════ */}
      <div style={{ display: tab === 'calendar' ? '' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, marginBottom: 24 }}>

          {/* Monthly mini-calendar */}
          <div className="card" style={{ padding: '22px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="section-title">{CAL_MONTH_NAMES[calView.m] + ' ' + calView.y}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="topnav-btn" style={{ width: 28, height: 28 }} onClick={() => changeMonth(-1)}><i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /></button>
                <button className="topnav-btn" style={{ width: 28, height: 28 }} onClick={() => changeMonth(1)}><i className="fa-solid fa-chevron-right" style={{ fontSize: 10 }} /></button>
              </div>
            </div>
            <div className="cal-grid">
              <div className="cal-day">Su</div><div className="cal-day">Mo</div><div className="cal-day">Tu</div><div className="cal-day">We</div><div className="cal-day">Th</div><div className="cal-day">Fr</div><div className="cal-day">Sa</div>
              {renderCalCells()}
            </div>
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #F1F5F9', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11.5, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, background: '#0EA5E9', borderRadius: '50%', display: 'inline-block' }} />Session scheduled</div>
              <div style={{ fontSize: 11.5, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: '#EFF6FF', border: '2px solid #0EA5E9', display: 'inline-block' }} />Selected day</div>
              <div style={{ fontSize: 11.5, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, background: '#CBD5E1', borderRadius: '50%', display: 'inline-block' }} />Past / session ended</div>
            </div>
            <button className="btn-primary" style={{ width: '100%', marginTop: 14, opacity: selected.isPast ? 0.45 : 1, cursor: selected.isPast ? 'not-allowed' : 'pointer' }} disabled={selected.isPast} onClick={bookSelectedDay}>
              {selected.isPast
                ? <><i className="fa-solid fa-lock" style={{ marginRight: 6 }} />Session Ended</>
                : <><i className="fa-solid fa-plus" style={{ marginRight: 6 }} />Book Selected Day</>}
            </button>
          </div>

          {/* Day view with time slots */}
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div className="section-title">{selected.label + ', ' + selected.year}</div>
                <div className="section-sub">Click a time slot to book · Showing all therapists and room allocations</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="sync-badge"><span className="sync-dot" />Live · {liveClock} PHT</span>
              </div>
            </div>
            <div style={{ padding: '0 0 14px', maxHeight: 420, overflowY: 'auto' }}>
              {renderDaySlots()}
            </div>
          </div>
        </div>
      </div>

      {/* ═══════ ADJUST & CANCEL SCHEDULES ═══════ */}
      <div style={{ display: tab === 'queue' ? '' : 'none' }}>
        <div style={{ marginBottom: 16, padding: '12px 18px', borderRadius: 10, background: '#F0F9FF', border: '1px solid #BFDBFE', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="sync-badge"><span className="sync-dot" />Real-time sync</span>
          <div style={{ fontSize: 13, color: '#1E40AF' }}>All reschedules and cancellations are saved directly to the database and reflected immediately across all portals.</div>
        </div>
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div className="section-title">Adjust &amp; Cancel Schedules</div>
              <div className="section-sub">Reschedule, cancel, or update existing therapy session reservations</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="confirmed">Confirmed</option>
                <option value="rescheduled">Rescheduled</option>
                <option value="cancelled">Cancelled</option>
                <option value="completed">Completed</option>
                <option value="declined">Declined</option>
                <option value="no_show">No-Show</option>
              </select>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th style={{ paddingLeft: 24 }}>Client</th><th>Date &amp; Time</th><th>Type</th><th>Therapist</th><th>Amount</th><th>Status</th><th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th></tr></thead>
              <tbody>{resTable.rows}</tbody>
            </table>
          </div>
          <div style={{ padding: '14px 24px', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>{resTable.count}</span>
          </div>
        </div>
      </div>

      {/* ═══════ MASTER CALENDAR ═══════ */}
      <div style={{ display: tab === 'mastercal' ? '' : 'none' }}>
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div><div className="section-title">Master Calendar: Therapist Assignments, Rooms &amp; Parent-Booked Slots</div><div className="section-sub">Comprehensive weekly view of all confirmed sessions, room allocations, and pending parent bookings</div></div>
            <div style={{ display: 'flex', gap: 8 }}><span className="pill pill-blue">{master.weekSelLabel}</span><span className="sync-badge"><span className="sync-dot" />Live</span></div>
          </div>
          <div style={{ overflowX: 'auto', padding: '16px 24px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 700 }}>
              <thead>{master.header}</thead>
              <tbody>{master.body}</tbody>
            </table>
            <div style={{ display: 'flex', gap: 16, marginTop: 14, paddingTop: 12, borderTop: '1px solid #F1F5F9', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569' }}><span style={{ width: 14, height: 14, background: '#DBEAFE', borderRadius: 3, display: 'inline-block' }} />OT Session</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569' }}><span style={{ width: 14, height: 14, background: '#CCFBF1', borderRadius: 3, display: 'inline-block' }} />Speech Session</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569' }}><span style={{ width: 14, height: 14, background: '#FEF9C3', borderRadius: 3, display: 'inline-block' }} />Pending Parent Booking</div>
              <div style={{ fontSize: 12, color: '#94A3B8', marginLeft: 'auto' }}><i className="fa-solid fa-calendar-week" style={{ marginRight: 5 }} />Week of {master.weekLabel}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════ PARENT REQUEST QUEUE ═══════ */}
      <div style={{ display: tab === 'parentqueue' ? '' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 24 }}>
          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-inbox" style={{ color: '#818CF8', marginRight: 7 }} />Parent Self-Service Request Queue</div>
            <div className="section-sub" style={{ marginBottom: 16 }}>Approve or decline parent-submitted booking requests</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {renderParentQueue()}
            </div>
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#64748B' }}>{pendingRequests.length + ' pending · ' + reservations.filter(r => r.channel === 'parent-portal').length + ' total parent requests in range'}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-edit" style={{ fontSize: 11 }} disabled={busy || !pendingRequests.length} onClick={approveAllClear}>Approve All Clear</button>
              </div>
            </div>
          </div>

          {/* Honest placeholder, no real conflict-detection logic exists on the backend yet */}
          <div className="card" style={{ padding: '22px 20px' }}>
            <div className="section-title" style={{ marginBottom: 4 }}><i className="fa-solid fa-triangle-exclamation" style={{ color: '#94A3B8', marginRight: 7 }} />Schedule Conflict Detection</div>
            <div className="section-sub" style={{ marginBottom: 16 }}>Automated double-booking / therapist-overlap flagging</div>
            <div style={{ padding: 16, borderRadius: 10, background: '#F8FAFC', border: '1px dashed #CBD5E1', textAlign: 'center', color: '#94A3B8' }}>
              <i className="fa-solid fa-hammer" style={{ fontSize: 22, marginBottom: 8, display: 'block' }} />
              <div style={{ fontSize: 13, fontWeight: 600, color: '#64748B', marginBottom: 4 }}>Not yet implemented</div>
              <div style={{ fontSize: 12, lineHeight: 1.6 }}>The system already blocks double-booking the exact same date + time slot at the database level.<br />Cross-checks like therapist-double-booked-across-rooms or room-capacity conflicts are not built yet.</div>
            </div>
          </div>
        </div>
      </div>
      </>
      )}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Booking and Appointment Module</span></div>

      {/* ══════════ Page-local modals ══════════ */}
      {modal && modal.kind === 'booking' && (
        <BookingModal selected={selected} daySlots={daySlots} slotState={slotState} defaultTime={modal.defaultTime} time={modal.time} clients={clients} clientLabel={clientLabel} busy={busy} onClose={closeModal} onConfirm={confirmBooking} />
      )}
      {modal && modal.kind === 'slot' && (
        <SlotActionsModal selected={selected} daySlots={daySlots} time={modal.time} reservation={modal.reservation} busy={busy} onClose={closeModal} onReschedule={rescheduleSlot} onCancel={cancelSlot} onNoShow={noShowSlot} onSaveAmount={saveAmount} />
      )}
      {modal && modal.kind === 'decline' && (
        <DeclineModal reservation={modal.reservation} busy={busy} onClose={closeModal} onConfirm={confirmDecline} />
      )}
      {modal && modal.kind === 'approve' && (
        <ApproveModal reservation={modal.reservation} busy={busy} onClose={closeModal} onConfirm={confirmApproveRequest} />
      )}
    </div>
  );
}

import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { LoadingState, TableEmptyRow } from '../../../components/ui.jsx';
import BookingModal from './reservations/BookingModal.jsx';
import SlotActionsModal from './reservations/SlotActionsModal.jsx';
import {
  pad, fmtYMD, todayPH, nowPH, minBookableDatePH, DAY_NAMES, CAL_MONTH_NAMES, MON_SHORT, SESSION_MIN,
  STATUS_PILL, slotMinutes, toMinutes,
  computeSelection, fmtShort, ASSESSMENT_TYPES, REQUIRED_ROLE_FOR_TYPE, effectiveSlotAvailable
} from './reservations/reservationsHelpers.js';

/* == page: reservations (real data via /api/reservations + /api/clients) == */
/* Shared helpers, and the page-local modal components (BookingModal,
   SlotActionsModal), now live under ./reservations/, this file keeps only
   the page component itself: state, data fetching, and the tab views
   (calendar / adjust & cancel schedules / master calendar / employee scheduling). */

/* ── Employee Scheduling tab, moved here from Client Records (it's booking
   availability, not a client-record concern), same live /api/shifts data ── */
const SCHED_AVATAR_COLORS = [
  { bg: '#DBEAFE', color: '#2563EB' }, { bg: '#CCFBF1', color: '#0F766E' },
  { bg: '#FEF3C7', color: '#D97706' }, { bg: '#EDE9FE', color: '#818CF8' },
  { bg: '#F3E8FF', color: '#9333EA' }, { bg: '#E0F2FE', color: '#0284C7' },
  { bg: '#DCFCE7', color: '#16A34A' }, { bg: '#FFE4E6', color: '#E11D48' },
];
const DOT_COLORS = { available: '#22C55E', off: '#E2E8F0' };
// Mon..Sun. Sunday defaults to closed, mirrors server/routes/shifts.js.
const ALL_WORK_DAYS = [true, true, true, true, true, true, false];

function hourLabel(h) {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return hr + ':00 ' + (h >= 12 ? 'PM' : 'AM');
}
/** Current hour in PH time (UTC+8), used to show On Shift / Off Duty. */
function currentHourPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
}
function mapShift(s, idx) {
  const initials = (s.name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const av = SCHED_AVATAR_COLORS[idx % SCHED_AVATAR_COLORS.length];
  const onShift = currentHourPH() >= s.start_hour && currentHourPH() < s.end_hour;
  const hasLunch = s.lunch_start_hour != null && s.lunch_end_hour != null;
  return {
    ...s,
    initials, bg: av.bg, color: av.color,
    start: hourLabel(s.start_hour), end: hourLabel(s.end_hour),
    lunch: hasLunch ? hourLabel(s.lunch_start_hour) + ' – ' + hourLabel(s.lunch_end_hour) : '—',
    status: onShift ? 'On Shift' : 'Off Duty',
    statusPill: onShift ? 'pill pill-green' : 'pill pill-gray',
  };
}

export default function Reservations({ toast, openModal }) {
  /* ── Section tabs ── */
  const [tab, setTab] = useState('calendar');

  /* ── Employee Scheduling tab state ── */
  const [shifts, setShifts] = useState([]);
  const fetchShifts = useCallback(async () => {
    try {
      const data = await api('/shifts');
      setShifts(data.map((s, i) => mapShift(s, i)));
      setDayEdits({});
    } catch (err) {
      toast('Failed to load shifts: ' + err.message, 'fa-triangle-exclamation');
    }
  }, [toast]);
  useEffect(() => { fetchShifts(); }, [fetchShifts]);

  /* availability matrix, unsaved day toggles, keyed by therapist_id */
  const [dayEdits, setDayEdits] = useState({});
  const [matrixSaving, setMatrixSaving] = useState(false);

  async function saveShift(therapistId, patch) {
    try {
      const r = await api('/shifts/' + therapistId, { method: 'PUT', body: patch });
      if (r.affected > 0) {
        toast(`Shift updated, ${r.affected} booking${r.affected > 1 ? 's' : ''} flagged for rescheduling, parents notified`, 'fa-calendar-xmark');
      } else {
        toast('Shift updated for ' + r.therapist, 'fa-calendar-check');
      }
      fetchShifts();
      return true;
    } catch (err) {
      toast(err.message, 'fa-triangle-exclamation');
      return false;
    }
  }

  /* Effective working days for a therapist = unsaved edit, else saved value. */
  const daysFor = s => dayEdits[s.therapist_id] || s.work_days || ALL_WORK_DAYS;

  function toggleDay(s, dayIdx) {
    const next = daysFor(s).slice();
    next[dayIdx] = !next[dayIdx];
    setDayEdits(prev => ({ ...prev, [s.therapist_id]: next }));
  }

  async function saveMatrix() {
    const changed = shifts.filter(s => {
      const edit = dayEdits[s.therapist_id];
      return edit && edit.join() !== (s.work_days || ALL_WORK_DAYS).join();
    });
    if (!changed.length) {
      toast('No availability changes to save', 'fa-circle-info');
      return;
    }
    setMatrixSaving(true);
    let saved = 0, flagged = 0;
    try {
      for (const s of changed) {
        const r = await api('/shifts/' + s.therapist_id, { method: 'PUT', body: { work_days: dayEdits[s.therapist_id] } });
        saved++;
        flagged += r.affected || 0;
      }
      toast(
        `Availability saved, ${saved} therapist${saved > 1 ? 's' : ''} updated` +
        (flagged > 0 ? ` · ${flagged} booking${flagged > 1 ? 's' : ''} flagged, parents notified` : ''),
        flagged > 0 ? 'fa-calendar-xmark' : 'fa-floppy-disk'
      );
      setDayEdits({});
      fetchShifts();
    } catch (err) {
      toast(err.message, 'fa-triangle-exclamation');
    } finally {
      setMatrixSaving(false);
    }
  }

  function exportShiftsCsv() {
    if (!shifts.length) { toast('No therapist shifts to export', 'fa-triangle-exclamation'); return; }
    const MON_FIRST_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const header = ['Therapist', 'Role', 'Shift Start', 'Shift End', 'Lunch Break', 'Status', 'Working Days'];
    const rows = shifts.map(s => [
      s.name || '', s.role || '', s.start, s.end, s.lunch, s.status,
      daysFor(s).map((working, i) => working ? MON_FIRST_DAYS[i] : null).filter(Boolean).join(' ')
    ]);
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    // Leading BOM, without it Excel guesses Windows-1252 instead of UTF-8 and
    // mangles non-ASCII characters (the "–" in Lunch Break becomes "â€“").
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `therapist-shift-schedules-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Shift schedules exported to CSV', 'fa-file-export');
  }

  /* ── Book Client must choose a service type before it can select a day/slot.
     For discipline-specific assessments (Speech-Language/Occupational), the
     therapist of that discipline is then picked inside the Book Slot modal,
     right below the Client field, rather than gating the calendar itself.
     Persisted in sessionStorage so a refresh mid-booking doesn't bounce staff
     back to the service-type picker and lose their place. ── */
  const BOOKING_SERVICE_TYPE_KEY = 'kc_booking_service_type';
  const [bookingServiceType, setBookingServiceType] = useState(() => {
    try {
      const saved = sessionStorage.getItem(BOOKING_SERVICE_TYPE_KEY);
      return ASSESSMENT_TYPES.includes(saved) ? saved : '';
    } catch { return ''; }
  });
  useEffect(() => {
    try {
      if (bookingServiceType) sessionStorage.setItem(BOOKING_SERVICE_TYPE_KEY, bookingServiceType);
      else sessionStorage.removeItem(BOOKING_SERVICE_TYPE_KEY);
    } catch { /* sessionStorage unavailable, just don't persist */ }
  }, [bookingServiceType]);
  const requiredTherapistRole = REQUIRED_ROLE_FOR_TYPE[bookingServiceType] || null;
  function resetBooking() { setBookingServiceType(''); }

  /* ── Selected day, auto-select the earliest bookable date (tomorrow, PH
     time) on load, today is always locked out (bookings need a day's lead
     time), so starting there would just force an extra click every visit. ── */
  const [selected, setSelected] = useState(() => computeSelection(minBookableDatePH()));

  /* ── Calendar view (0-indexed month), matches whatever month `selected` falls in. ── */
  const [calView, setCalView] = useState(() => {
    const [y, m] = minBookableDatePH().split('-').map(Number);
    return { y, m: m - 1 };
  });

  /* ── Master Calendar week navigation, 0 = the current week, +/-1 a week
     ahead/behind, etc. ── */
  const [masterWeekOffset, setMasterWeekOffset] = useState(0);

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
  const slotAvailable = t => effectiveSlotAvailable(slotByTime(t), bookingServiceType) > 0;

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
  // Bookings must be made at least a day ahead, same-day booking isn't allowed
  // even though same-day *viewing* of the schedule still is.
  const sameDayLocked = selected.date <= todayISO;

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
    if (sameDayLocked) { toast('Bookings must be made at least a day in advance', 'fa-lock'); return; }
    openBookingModal(null);
  }

  /* ══════════ Booking modal ══════════ */
  function openBookingModal(time) {
    if (sameDayLocked) { toast('Bookings must be made at least a day in advance', 'fa-lock'); return; }
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
    const therapistSelect = document.getElementById('modal-therapist-select');
    const bookedTime = timeSelect ? timeSelect.value : '';
    const clientVal = clientSelect ? clientSelect.value : '';
    const therapistVal = therapistSelect ? therapistSelect.value : '';
    const bkErr = msg => {
      const box = document.getElementById('bk-err');
      if (box) { document.getElementById('bk-err-msg').textContent = msg; box.style.display = 'block'; }
      toast(msg, 'fa-circle-exclamation');
    };
    if (!bookingServiceType) { bkErr('Select a service type first.'); return; }
    if (requiredTherapistRole && !therapistVal) { bkErr('Select a therapist first.'); if (therapistSelect) { therapistSelect.style.borderColor = '#EF4444'; therapistSelect.focus(); } return; }
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
          session_type: bookingServiceType,
          therapist_name: therapistVal || undefined,
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
      const isInitialAssessment = bookingServiceType === 'Initial Assessment';
      const effCapacity = isInitialAssessment ? 1 : slot.capacity;
      const openCount = isInitialAssessment ? effectiveSlotAvailable(slot, bookingServiceType) : Math.max(0, slot.capacity - bks.length);

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
          + Click to book this slot{isInitialAssessment ? ' · 1 Initial Assessment slot per hour' : (slot.capacity > 1 ? ` · ${openCount} of ${effCapacity} therapists free` : '')}
        </div>
      );
      const lockedEmpty = (label) => (
        <div className="slot-block empty" key="locked" style={{ opacity: 0.5, pointerEvents: 'none', cursor: 'not-allowed' }}>
          <i className="fa-solid fa-lock" style={{ marginRight: 5, fontSize: 10 }} />{label}
        </div>
      );
      const lunchBlock = () => (
        <div className="slot-block empty" key="lunch" style={{ opacity: 0.65, pointerEvents: 'none', cursor: 'not-allowed', background: '#FFF7ED', borderLeft: '3px solid #FDBA74', color: '#9A3412', fontWeight: 600 }}>
          <i className="fa-solid fa-utensils" style={{ marginRight: 6, fontSize: 10 }} />Lunch Break
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
          if (slot.lunch_break) blocks.push(lunchBlock());
          else if (openCount > 0) blocks.push(lockedEmpty('Book at least a day in advance'));
        }
      } else {
        bks.forEach(bk => blocks.push(bookedBlock(bk)));
        if (slot.lunch_break) blocks.push(lunchBlock());
        else if (openCount > 0) blocks.push(emptyBlock());
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
    weekStart.setDate(today.getDate() - ((dayOfWeek === 0 ? 7 : dayOfWeek) - 1) + masterWeekOffset * 7);
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

  const resTable = renderResTable();
  const master = renderMasterCal();

  return (
    <div className="spa-page" id="spa-reservations">
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Booking and Appointment</h1>
        </div>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className={'res-tab' + (tab === 'calendar' ? ' active' : '')} onClick={() => setTab('calendar')}><i className="fa-solid fa-calendar-days" style={{ marginRight: 6 }} />Book Client</button>
        <button className={'res-tab' + (tab === 'queue' ? ' active' : '')} onClick={() => setTab('queue')}><i className="fa-solid fa-list-check" style={{ marginRight: 6 }} />Adjust &amp; Cancel Schedules</button>
        <button className={'res-tab' + (tab === 'mastercal' ? ' active' : '')} onClick={() => setTab('mastercal')}><i className="fa-solid fa-table-cells-large" style={{ marginRight: 6 }} />Master Calendar</button>
        <button className={'res-tab' + (tab === 'scheduling' ? ' active' : '')} onClick={() => setTab('scheduling')}><i className="fa-solid fa-calendar-alt" style={{ marginRight: 6 }} />Employee Scheduling</button>
      </div>

      {loading && <LoadingState label="Loading reservations…" />}

      {!loading && (
      <>
      {/* ═══════ INTERACTIVE RESERVATION BOOKING CALENDAR ═══════ */}
      <div style={{ display: tab === 'calendar' ? '' : 'none' }}>
        {!bookingServiceType ? (
          <div className="card" style={{ padding: '28px 24px', marginBottom: 24 }}>
            <div className="section-title" style={{ marginBottom: 4 }}>Select a Service Type to Start Booking</div>
            <div className="section-sub" style={{ marginBottom: 18 }}>Pick what this booking is for before choosing a day and time slot.</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {ASSESSMENT_TYPES.map(t => (
                <button key={t} className="btn-secondary" style={{ padding: '16px 14px', textAlign: 'left', fontWeight: 600 }} onClick={() => setBookingServiceType(t)}>
                  <i className="fa-solid fa-clipboard-check" style={{ marginRight: 8, color: '#0EA5E9' }} />{t}
                </button>
              ))}
            </div>
          </div>
        ) : (
        <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9, background: '#F0F9FF', border: '1px solid #BAE6FD', marginBottom: 16 }}>
          <i className="fa-solid fa-clipboard-check" style={{ color: '#0EA5E9', fontSize: 16 }} />
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', flex: 1 }}>Booking: {bookingServiceType}</div>
          <button className="btn-secondary" style={{ fontSize: 11.5, padding: '5px 10px' }} onClick={resetBooking}>Change</button>
        </div>
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
            <button className="btn-primary" style={{ width: '100%', marginTop: 14, opacity: sameDayLocked ? 0.45 : 1, cursor: sameDayLocked ? 'not-allowed' : 'pointer' }} disabled={sameDayLocked} onClick={bookSelectedDay}>
              {selected.isPast
                ? <><i className="fa-solid fa-lock" style={{ marginRight: 6 }} />Session Ended</>
                : sameDayLocked
                  ? <><i className="fa-solid fa-lock" style={{ marginRight: 6 }} />Book at Least a Day Ahead</>
                  : <><i className="fa-solid fa-plus" style={{ marginRight: 6 }} />Book Selected Day</>}
            </button>
          </div>

          {/* Day view with time slots */}
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div className="section-title">{selected.label + ', ' + selected.year}</div>
                <div className="section-sub">
                  {bookingServiceType === 'Initial Assessment'
                    ? 'Click a time slot to book · 1 Initial Assessment per hour clinic-wide'
                    : requiredTherapistRole
                      ? `Click a time slot to book · Pick the ${requiredTherapistRole === 'speech' ? 'Speech-Language' : 'Occupational'} therapist in the booking modal`
                      : 'Click a time slot to book · Showing all therapists and room allocations'}
                </div>
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
        </>
        )}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button className="topnav-btn" style={{ width: 28, height: 28 }} onClick={() => setMasterWeekOffset(o => o - 1)} title="Previous week"><i className="fa-solid fa-chevron-left" style={{ fontSize: 10 }} /></button>
              <span className="pill pill-blue">{master.weekSelLabel}</span>
              <button className="topnav-btn" style={{ width: 28, height: 28 }} onClick={() => setMasterWeekOffset(o => o + 1)} title="Next week"><i className="fa-solid fa-chevron-right" style={{ fontSize: 10 }} /></button>
              {masterWeekOffset !== 0 && (
                <button className="btn-secondary" style={{ fontSize: 11.5, padding: '5px 10px' }} onClick={() => setMasterWeekOffset(0)}>This Week</button>
              )}
              <span className="sync-badge"><span className="sync-dot" />Live</span>
            </div>
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

      {/* ═══════════════ EMPLOYEE SCHEDULING ═══════════════ */}
      <div style={{ display: tab === 'scheduling' ? '' : 'none' }}>
        <div className="sched-grid">
          {/* View intricate therapist shift schedules */}
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <div><div className="section-title">Therapist Shift Schedules</div><div className="section-sub">View intricate therapist shift schedules</div></div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} defaultValue="All Departments"><option>All Departments</option><option>Occupational Therapy</option><option>Speech Therapy</option></select>
                <button className="qa-btn" style={{ width: 'auto', padding: '0 14px', height: 34, fontSize: 12.5 }} onClick={exportShiftsCsv}>
                  <i className="fa-solid fa-file-export" style={{ color: '#0D9488' }} /> Export CSV
                </button>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th style={{ paddingLeft: 24 }}>Therapist</th><th>Shift Start</th><th>Shift End</th><th>Lunch Break</th><th>Status</th><th style={{ paddingRight: 24, textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {shifts.length === 0 ? (
                    <tr><td colSpan={6} style={{ textAlign: 'center', padding: '28px 24px', color: '#94A3B8', fontSize: 12.5 }}>No therapist accounts yet, add therapists in User Management to schedule shifts.</td></tr>
                  ) : shifts.map(s => (
                    <tr key={s.therapist_id}><td style={{ paddingLeft: 24 }}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="act-avatar" style={{ width: 30, height: 30, background: s.bg, color: s.color, fontSize: 11 }}>{s.initials}</div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{s.name}</div></div></td><td>{s.start}</td><td>{s.end}</td><td style={{ color: s.lunch === '—' ? '#94A3B8' : '#0F172A' }}>{s.lunch}</td><td><span className={s.statusPill}>{s.status}</span></td><td style={{ paddingRight: 24, textAlign: 'right' }}><button className="btn-edit" onClick={() => openModal('edit-shift', { name: s.name, start_hour: s.start_hour, end_hour: s.end_hour, lunch_start_hour: s.lunch_start_hour, lunch_end_hour: s.lunch_end_hour, onSave: patch => saveShift(s.therapist_id, patch) })}>Edit Shift</button></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '10px 24px 16px', fontSize: 11.5, color: '#94A3B8' }}>
              <i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Shifts control booking availability: each hour offers as many reservation slots as there are therapists on shift, and sessions are auto-assigned to whoever is free.
            </div>
          </div>

          {/* Manage therapist availability matrices */}
          <div className="card" style={{ padding: '22px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div><div className="section-title">Availability Matrix</div><div className="section-sub">Manage therapist availability</div></div>
              <button className="btn-primary" onClick={saveMatrix} disabled={matrixSaving}><i className={'fa-solid ' + (matrixSaving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 4 }} />{matrixSaving ? 'Saving…' : 'Save'}</button>
            </div>
            {/* Weekly grid */}
            <div style={{ overflowX: 'auto', marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    <th style={{ padding: '8px 10px', textAlign: 'left', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Therapist</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Mon</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Tue</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Wed</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Thu</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Fri</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Sat</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Sun</th>
                  </tr>
                </thead>
                <tbody id="avail-matrix">
                  {shifts.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: '24px 10px', color: '#94A3B8', fontSize: 12 }}>No therapist accounts yet.</td></tr>
                  ) : shifts.map((s, rowIdx) => (
                    <tr key={s.therapist_id} style={rowIdx % 2 === 1 ? { background: '#F8FAFC' } : undefined}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: '#0F172A', fontSize: 12 }}>{s.name}</td>
                      {daysFor(s).map((working, dayIdx) => (
                        <td key={dayIdx} style={{ textAlign: 'center', padding: 6 }}><span className="avail-dot" style={{ background: working ? DOT_COLORS.available : DOT_COLORS.off }} onClick={() => toggleDay(s, dayIdx)} title={working ? 'Available, click to set day off' : 'Day off, click to set available'} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#64748B' }}><span className="avail-dot" style={{ background: '#22C55E', pointerEvents: 'none', width: 12, height: 12 }} /> Available</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#64748B' }}><span className="avail-dot" style={{ background: '#E2E8F0', pointerEvents: 'none', width: 12, height: 12 }} /> Day off</div>
              <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 4 }}>· Click a dot to toggle, then Save. Day-off therapists add no booking slots that day; affected bookings are flagged and parents notified.</span>
            </div>
          </div>
        </div>
      </div>

      </>
      )}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Booking and Appointment Module</span></div>

      {/* ══════════ Page-local modals ══════════ */}
      {modal && modal.kind === 'booking' && (
        <BookingModal selected={selected} daySlots={daySlots} slotState={slotState} defaultTime={modal.defaultTime} time={modal.time} clients={clients} clientLabel={clientLabel} serviceType={bookingServiceType} busy={busy} onClose={closeModal} onConfirm={confirmBooking} />
      )}
      {modal && modal.kind === 'slot' && (
        <SlotActionsModal selected={selected} daySlots={daySlots} time={modal.time} reservation={modal.reservation} busy={busy} onClose={closeModal} onReschedule={rescheduleSlot} onCancel={cancelSlot} onNoShow={noShowSlot} onSaveAmount={saveAmount} />
      )}
    </div>
  );
}

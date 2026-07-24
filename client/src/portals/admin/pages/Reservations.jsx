import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { LoadingState, TableEmptyRow, Modal } from '../../../components/ui.jsx';
import BookingModal from './reservations/BookingModal.jsx';
import SlotActionsModal from './reservations/SlotActionsModal.jsx';
import {
  pad, fmtYMD, todayPH, nowPH, minBookableDatePH, DAY_NAMES, CAL_MONTH_NAMES, MON_SHORT, SESSION_MIN,
  STATUS_PILL, slotMinutes, toMinutes, effectiveStatusKey, disciplineOfSessionType,
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
  { bg: '#E0F2FE', color: 'var(--cat-1)' }, { bg: '#FEF3C7', color: 'var(--cat-2)' },
  { bg: '#CCFBF1', color: 'var(--cat-3)' }, { bg: '#FCE7F3', color: 'var(--cat-4)' },
  { bg: '#EDE9FE', color: 'var(--cat-5)' }, { bg: '#CFFAFE', color: 'var(--cat-6)' },
  { bg: '#FCE7F3', color: 'var(--cat-7)' }, { bg: '#E0E7FF', color: 'var(--cat-8)' },
];
const DOT_COLORS = { available: '#22C55E', off: '#E2E8F0' };
// Mon..Sun. Sunday defaults to closed, mirrors server/routes/shifts.js.
const ALL_WORK_DAYS = [true, true, true, true, true, true, false];
// Same 6 AM – 10 PM picker range as EditShiftModal's own hour selects, so
// Clinic Operating Hours reads consistently with individual shift editing.
const CLINIC_HOURS = Array.from({ length: 17 }, (_, i) => i + 6);

function hourLabel(h) {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return hr + ':00 ' + (h >= 12 ? 'PM' : 'AM');
}
/** Current hour in PH time (UTC+8), used to show On Shift / Off Duty. */
function currentHourPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
}
/** Monday of the week containing `d`. */
function mondayOf(d) {
  const dow = d.getDay();
  const m = new Date(d);
  m.setDate(d.getDate() - ((dow === 0 ? 7 : dow) - 1));
  return m;
}
/** How many weeks (relative to today's week) a "YYYY-MM-DD" date falls in,
 *  used so picking a date on the Master Calendar's date-jump input lands on
 *  the correct week regardless of which day of that week was picked. */
function weekOffsetForDate(dateStr) {
  const target = new Date(dateStr + 'T00:00:00');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((mondayOf(target) - mondayOf(today)) / (7 * 24 * 60 * 60 * 1000));
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

const RESERVATIONS_TAB_KEYS = ['calendar', 'queue', 'mastercal', 'scheduling'];

export default function Reservations({ toast, openModal }) {
  /* ── Section tabs ── */
  const [tab, setTab] = useState(() => {
    const saved = localStorage.getItem('kid_admin_reservations_tab');
    return RESERVATIONS_TAB_KEYS.includes(saved) ? saved : 'calendar';
  });
  useEffect(() => { localStorage.setItem('kid_admin_reservations_tab', tab); }, [tab]);

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

  /* ── Clinic Operating Hours, editable from here since this is where shifts
     are managed, backed by the same branding_settings row, via its own
     admin+staff endpoint (see server/routes/settings.js). These are the
     *functional* hours Initial Assessment slots are generated from
     (server/routes/reservations.js's getClinicHours()), not shift-driven
     like every other session type, intake has no dedicated therapist yet. ── */
  const [operatingHours, setOperatingHours] = useState({
    clinic_weekday_start_hour: 8, clinic_weekday_end_hour: 18,
    clinic_saturday_start_hour: 9, clinic_saturday_end_hour: 15
  });
  const [hoursSaving, setHoursSaving] = useState(false);
  useEffect(() => {
    api('/settings/hours').then(data => setOperatingHours(h => ({ ...h, ...data }))).catch(() => {});
  }, []);
  async function saveOperatingHours() {
    if (operatingHours.clinic_weekday_start_hour >= operatingHours.clinic_weekday_end_hour) {
      toast('Weekday opening hour must be before closing hour', 'fa-triangle-exclamation');
      return;
    }
    if (operatingHours.clinic_saturday_start_hour >= operatingHours.clinic_saturday_end_hour) {
      toast('Saturday opening hour must be before closing hour', 'fa-triangle-exclamation');
      return;
    }
    setHoursSaving(true);
    try {
      const data = await api('/settings/hours', { method: 'PUT', body: operatingHours });
      setOperatingHours(h => ({ ...h, ...data }));
      toast('Clinic operating hours updated', 'fa-clock');
    } catch (err) {
      toast(err.message || 'Failed to update operating hours', 'fa-triangle-exclamation');
    } finally {
      setHoursSaving(false);
    }
  }

  /* ── Clinic holidays/closures, specific one-off dates (not the weekly
     weekday/Saturday pattern above), no bookings of any kind are allowed on
     one, see server/routes/reservations.js's isClinicHoliday(). ── */
  const [holidays, setHolidays] = useState([]);
  const fetchHolidays = useCallback(async () => {
    try {
      setHolidays(await api('/settings/holidays?from=' + todayPH()));
    } catch (err) {
      toast('Failed to load clinic closures: ' + err.message, 'fa-triangle-exclamation');
    }
  }, [toast]);
  useEffect(() => { fetchHolidays(); }, [fetchHolidays]);

  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayLabel, setNewHolidayLabel] = useState('');
  const [holidaySaving, setHolidaySaving] = useState(false);
  async function addHoliday() {
    if (!newHolidayDate) { toast('Pick a date first', 'fa-triangle-exclamation'); return; }
    setHolidaySaving(true);
    try {
      await api('/settings/holidays', { method: 'POST', body: { date: newHolidayDate, label: newHolidayLabel } });
      setNewHolidayDate('');
      setNewHolidayLabel('');
      toast('Clinic closure added', 'fa-calendar-xmark');
      fetchHolidays();
    } catch (err) {
      toast(err.message || 'Failed to add closure', 'fa-triangle-exclamation');
    } finally {
      setHolidaySaving(false);
    }
  }
  async function removeHoliday(id) {
    try {
      await api('/settings/holidays/' + id, { method: 'DELETE' });
      toast('Clinic closure removed', 'fa-calendar-check');
      fetchHolidays();
    } catch (err) {
      toast(err.message || 'Failed to remove closure', 'fa-triangle-exclamation');
    }
  }

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

  /* ── Admin & Staff availability, same shift/day-off tracking as therapists
     (?scope=admin on the same /shifts endpoint), purely for schedule
     visibility, never fed into booking capacity/slot generation. ── */
  const [adminShifts, setAdminShifts] = useState([]);
  const fetchAdminShifts = useCallback(async () => {
    try {
      const data = await api('/shifts?scope=admin');
      setAdminShifts(data.map((s, i) => mapShift(s, i)));
      setAdminDayEdits({});
    } catch (err) {
      toast('Failed to load admin/staff availability: ' + err.message, 'fa-triangle-exclamation');
    }
  }, [toast]);
  useEffect(() => { fetchAdminShifts(); }, [fetchAdminShifts]);

  const [adminDayEdits, setAdminDayEdits] = useState({});
  const [adminMatrixSaving, setAdminMatrixSaving] = useState(false);

  async function saveAdminShift(profileId, patch) {
    try {
      const r = await api('/shifts/' + profileId, { method: 'PUT', body: patch });
      toast('Availability updated for ' + r.therapist, 'fa-calendar-check');
      fetchAdminShifts();
      return true;
    } catch (err) {
      toast(err.message, 'fa-triangle-exclamation');
      return false;
    }
  }

  const daysForAdmin = s => adminDayEdits[s.therapist_id] || s.work_days || ALL_WORK_DAYS;

  function toggleAdminDay(s, dayIdx) {
    const next = daysForAdmin(s).slice();
    next[dayIdx] = !next[dayIdx];
    setAdminDayEdits(prev => ({ ...prev, [s.therapist_id]: next }));
  }

  async function saveAdminMatrix() {
    const changed = adminShifts.filter(s => {
      const edit = adminDayEdits[s.therapist_id];
      return edit && edit.join() !== (s.work_days || ALL_WORK_DAYS).join();
    });
    if (!changed.length) {
      toast('No availability changes to save', 'fa-circle-info');
      return;
    }
    setAdminMatrixSaving(true);
    try {
      for (const s of changed) {
        await api('/shifts/' + s.therapist_id, { method: 'PUT', body: { work_days: adminDayEdits[s.therapist_id] } });
      }
      toast(`Availability saved, ${changed.length} account${changed.length > 1 ? 's' : ''} updated`, 'fa-floppy-disk');
      setAdminDayEdits({});
      fetchAdminShifts();
    } catch (err) {
      toast(err.message, 'fa-triangle-exclamation');
    } finally {
      setAdminMatrixSaving(false);
    }
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
  // A slot conflict (already booked, either caught client-side or a race lost
  // at the server) surfaces as its own confirm dialog on top of the booking
  // modal instead of a passive inline error, "continue" clears the stale
  // time/client picks so the next attempt can't repeat the same conflict,
  // "no" just dismisses and leaves the form exactly as it was.
  const [bookingConflict, setBookingConflict] = useState(null); // { message } | null
  const [bookingModalResetKey, setBookingModalResetKey] = useState(0);

  /* ── Read-only Booking Details view, for confirmed bookings in Adjust & Cancel Schedules ── */
  const [viewBooking, setViewBooking] = useState(null);

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
  async function refetchDaySlots(date, silent) {
    const reqId = ++daySlotsReqRef.current;
    try {
      // Initial Assessment is generated from the clinic's own operating hours
      // (not any specific therapist's shift), so the server needs to know
      // which service type is being booked to pick the right slot source.
      const qs = 'date=' + (date || selected.date) + (bookingServiceType ? '&session_type=' + encodeURIComponent(bookingServiceType) : '');
      const data = await api('/reservations/slots?' + qs);
      // Ignore this response if a newer request has since been kicked off,
      // prevents an older/slower poll from overwriting fresher data and
      // causing the "pops up then disappears" flicker.
      if (reqId === daySlotsReqRef.current) setDaySlots(data);
    } catch (e) {
      if (reqId !== daySlotsReqRef.current) return;
      // A real server error (e.g. a pending migration) must surface loudly,
      // silently keeping stale/empty slots here just reads as "no slots ever
      // available" with no clue why. The background poll stays quiet though,
      // same reasoning as refetchReservations(silent), no toast spam every 30s.
      if (!silent) toast(e.message || 'Failed to load time slots', 'fa-triangle-exclamation');
    }
  }
  useEffect(() => {
    refetchDaySlots(selected.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.date, bookingServiceType]);

  const slotByTime = t => daySlots.find(s => s.time_slot === t);
  const roleOfTherapist = name => shifts.find(s => s.name === name)?.role;
  /** How many more bookings a slot can actually take for `serviceType`: Initial
   *  Assessment stays clinic-wide (effectiveSlotAvailable's own 1-per-hour cap),
   *  Occupational/Speech-Language Assessment are scoped to just that discipline's
   *  on-shift therapists (not the clinic's combined capacity across both
   *  disciplines), everything else falls back to the slot's raw capacity. This is
   *  the single source of truth for both the "X of Y free" label (renderDaySlots)
   *  and whether a slot is actually clickable (slotAvailable/openBookingModal),
   *  they must never disagree, or a slot can look bookable but silently no-op. */
  function disciplineOpenCount(slot, serviceType) {
    if (!slot) return 0;
    if (slot.lunch_break) return 0;
    const role = REQUIRED_ROLE_FOR_TYPE[serviceType];
    if (!role) return effectiveSlotAvailable(slot, serviceType);
    const disciplineTherapists = (slot.therapists || []).filter(n => roleOfTherapist(n) === role);
    const disciplineBookings = (slot.reservations || []).filter(r => disciplineOfSessionType(r.session_type) === role);
    return Math.max(0, disciplineTherapists.length - disciplineBookings.length);
  }
  const slotAvailable = t => disciplineOpenCount(slotByTime(t), bookingServiceType) > 0;

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
      refetchDaySlots(undefined, silent); // keep slot capacities in sync with bookings
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
    if (!slotAvailable(bookedTime)) {
      setBookingConflict({ message: 'That time is already booked, someone else has a session at ' + bookedTime + '.' });
      return;
    }
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
      // A 409 here means the slot lost the race between opening this modal and
      // clicking Confirm (someone else booked it in between), that's the same
      // "already existing" conflict as the client-side check above, not a
      // plain validation error, so it gets the same confirm dialog.
      if (e.status === 409) setBookingConflict({ message: e.message || 'That slot was just booked by someone else.' });
      else bkErr(e.message || 'Failed to create booking');
    } finally {
      setBusy(false);
    }
  }

  // "Yes, Continue": clears the time and client picks that just conflicted so
  // the booking modal comes back to a clean slate for a fresh pick. The client
  // field is a React-controlled input (BookingModal's own clientSearch state),
  // reaching in and setting the DOM value directly wouldn't stick past the
  // next render, so this bumps bookingModalResetKey instead, remounting
  // BookingModal fresh, same as picking "Book Client" from scratch, only the
  // booking modal remounts, the underlying page/day selection is untouched.
  // Also refreshes this day's slot capacities so the dropdown can't offer the
  // same now-taken time again.
  function continueAfterConflict() {
    setBookingConflict(null);
    setBookingModalResetKey(k => k + 1);
    // BookingModal reads its initial time selection from this same modal
    // state's defaultTime/time, remounting it (above) alone would just
    // reinitialize back to the exact time that just conflicted.
    setModal(m => (m && m.kind === 'booking') ? { ...m, time: null, defaultTime: null } : m);
    refetchDaySlots(selected.date, true);
  }
  // "No": just dismiss the dialog, the booking modal and everything picked in
  // it stay exactly as they were.
  function cancelAfterConflict() {
    setBookingConflict(null);
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

  async function endSessionSlot(reservationId) {
    setBusy(true);
    try {
      await api('/reservations/' + reservationId, { method: 'PUT', body: { status: 'completed' } });
      closeModal();
      await refetchReservations();
      toast('Session ended, marked as completed', 'fa-flag-checkered');
    } catch (e) {
      toast(e.message || 'Failed to end session', 'fa-circle-exclamation');
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

  /* ══════════ Adjust & Cancel Schedules table ══════════ */
  const [statusFilter, setStatusFilter] = useState('all');
  const [resSearch, setResSearch] = useState('');
  const [resPage, setResPage] = useState(1);
  useEffect(() => { setResPage(1); }, [statusFilter, resSearch]);

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
      const holiday = holidays.find(h => h.date === selected.date);
      return (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: '#94A3B8', fontSize: 12.5 }}>
          {holiday
            ? <>The clinic is closed on {fmtShort(holiday.date)}{holiday.label ? ' (' + holiday.label + ')' : ''}, no bookings are allowed.</>
            : 'No time slots for this day, no therapists are on shift. Set shifts in Client Records → Employee Scheduling.'}
        </div>
      );
    }
    return daySlots.map(slot => {
      const time = slot.time_slot;
      const allBks = slot.reservations || [];
      const isInitialAssessment = bookingServiceType === 'Initial Assessment';
      // Same source of truth slotAvailable()/openBookingModal() use for whether
      // a slot is actually clickable, the label shown here must never claim
      // more room than a click will actually honor.
      const openCount = disciplineOpenCount(slot, bookingServiceType);
      const effCapacity = isInitialAssessment
        ? 1
        : requiredTherapistRole
          ? (slot.therapists || []).filter(n => roleOfTherapist(n) === requiredTherapistRole).length
          : slot.capacity;
      // Only show bookings for the same discipline currently being booked
      // (Initial Assessment stays clinic-wide/type-only), so the slot view
      // isn't cluttered with unrelated bookings while picking a time for one.
      // Matching by discipline (not exact session_type) means a Combined
      // client's already-booked regular "Occupational Therapy"/"Speech
      // Therapy" session still shows up here, since it occupies the same
      // therapist's schedule as an Occupational/Speech-Language Assessment
      // would. Capacity above still accounts for every booking either way.
      const bookingDiscipline = disciplineOfSessionType(bookingServiceType);
      const bks = isInitialAssessment
        ? allBks.filter(r => r.session_type === 'Initial Assessment')
        : bookingDiscipline
          ? allBks.filter(r => disciplineOfSessionType(r.session_type) === bookingDiscipline)
          : allBks;

      const bookedBlock = (bk, extra) => {
        const client = bk.clients?.full_name || '-';
        const statusInfo = extra?.ongoing ? STATUS_PILL.ongoing : (STATUS_PILL[bk.status] || STATUS_PILL.pending);
        const showBadge = extra?.ongoing || bk.status !== 'confirmed';
        const pendingPayment = !extra?.ongoing && (bk.status === 'pending' || bk.status === 'awaiting_payment');
        const blockColors = pendingPayment
          ? { background: '#FEF9C3', color: '#B45309', borderLeft: '3px solid #F59E0B' }
          : { background: '#DCFCE7', color: '#166534', borderLeft: '3px solid #16A34A' };
        return (
          <div key={bk.id} className="slot-block" style={{ ...blockColors, cursor: extra?.locked ? 'not-allowed' : 'pointer', ...(extra?.dim ? { opacity: 0.55, pointerEvents: 'none' } : {}) }} onClick={extra?.locked ? undefined : () => openSlotActions(time, bk)}>
            <i className="fa-solid fa-calendar-check" style={{ marginRight: 6, fontSize: 10 }} />
            <strong>{client}</strong>
            {bk.duration_min ? ' · ' + bk.duration_min + ' minutes' : ''}
            {bk.therapist_name ? ' · ' + bk.therapist_name : ''}
            {bk.room ? ' · ' + bk.room : ''}
            {showBadge && <span style={{ fontSize: 10, background: '#FEF9C3', color: '#B45309', borderRadius: 5, padding: '1px 7px', marginLeft: 6, fontWeight: 700 }}>{statusInfo.label.toUpperCase()}</span>}
            <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 8 }}>click to reschedule / cancel</span>
          </div>
        );
      };
      const emptyBlock = () => (
        <div className="slot-block empty" key="empty" onClick={() => openBookingModal(time)}>
          + Click to book this slot{isInitialAssessment ? ' · 1 Initial Assessment slot per hour' : ` · ${openCount} of ${effCapacity} therapist${effCapacity === 1 ? '' : 's'} free`}
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
              <i className="fa-solid fa-hourglass-half" style={{ marginRight: 6, fontSize: 10 }} />Ongoing, this slot started at {time}
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
    const search = resSearch.trim().toLowerCase();
    const filtered = reservations
      .filter(r => {
        if (statusFilter === 'all') return true;
        const key = effectiveStatusKey(r);
        if (statusFilter === 'pending') return key === 'pending' || key === 'awaiting_payment';
        return key === statusFilter;
      })
      .filter(r => !search
        || (r.clients?.full_name || '').toLowerCase().includes(search)
        || (r.clients?.client_code || '').toLowerCase().includes(search))
      .slice()
      .sort((a, b) => (b.date + b.time_slot).localeCompare(a.date + a.time_slot));

    if (!filtered.length) {
      return {
        rows: <TableEmptyRow colSpan="7" label="No bookings found for this filter" />,
        count: 'No bookings found', page: 1, totalPages: 1
      };
    }
    const TERMINAL_STATUSES = ['cancelled', 'declined', 'completed', 'no_show'];
    const RES_TABLE_LIMIT = 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / RES_TABLE_LIMIT));
    const page = Math.min(resPage, totalPages);
    const visible = filtered.slice((page - 1) * RES_TABLE_LIMIT, page * RES_TABLE_LIMIT);
    const rows = visible.map(r => {
      const dateLabel = fmtShort(r.date);
      const typePill = /speech/i.test(r.session_type || '') ? 'pill-teal' : 'pill-blue';
      const st = STATUS_PILL[effectiveStatusKey(r)] || STATUS_PILL.pending;
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
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {r.status === 'confirmed' && (
                <button className="btn-edit" onClick={() => setViewBooking(r)}><i className="fa-solid fa-eye" style={{ marginRight: 4 }} />View</button>
              )}
              {TERMINAL_STATUSES.includes(r.status) ? (
                <span style={{ fontSize: 12, color: '#CBD5E1' }}>-</span>
              ) : (
                <button className="btn-edit" onClick={() => manageBookingFromQueue(r)}><i className="fa-solid fa-sliders" style={{ marginRight: 4 }} />Manage</button>
              )}
            </div>
          </td>
        </tr>
      );
    });
    const count = filtered.length > RES_TABLE_LIMIT
      ? `Showing ${visible.length} of ${filtered.length} bookings`
      : `Showing ${filtered.length} booking${filtered.length === 1 ? '' : 's'}`;
    return { rows, count, page, totalPages };
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
                  const pending = bk.status === 'pending' || bk.status === 'awaiting_payment';
                  const blockBg = pending ? '#FEF9C3' : (isSpeech ? '#CFFAFE' : '#CCFBF1');
                  const blockColor = pending ? '#B45309' : (isSpeech ? 'var(--cat-6)' : 'var(--cat-3)');
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
        <div className="card" style={{ padding: '22px 0 0', marginBottom: 24 }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div className="section-title">Adjust &amp; Cancel Schedules</div>
              <div className="section-sub">Reschedule, cancel, or update existing therapy session reservations</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ position: 'relative' }}>
                <i className="fa-solid fa-magnifying-glass" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 11.5, color: '#94A3B8' }} />
                <input className="form-input" style={{ width: 190, height: 34, fontSize: 12.5, paddingLeft: 30 }} placeholder="Search name or client ID…" value={resSearch} onChange={e => setResSearch(e.target.value)} />
              </div>
              <select className="form-select" style={{ width: 'auto', height: 34, fontSize: 12.5 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="ongoing">Ongoing</option>
                <option value="confirmed">Confirmed</option>
                <option value="rescheduled">Rescheduled</option>
                <option value="cancelled">Cancelled</option>
                <option value="completed">Completed</option>
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
          <div style={{ padding: '14px 24px', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>{resTable.count}</span>
            {resTable.totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="btn-secondary" style={{ fontSize: 11.5, padding: '5px 12px', opacity: resTable.page === 1 ? .5 : 1 }} disabled={resTable.page === 1} onClick={() => setResPage(p => Math.max(1, p - 1))}>
                  <i className="fa-solid fa-chevron-left" style={{ marginRight: 4 }} />Back
                </button>
                <span style={{ fontSize: 12, color: '#64748B' }}>Page {resTable.page} of {resTable.totalPages}</span>
                <button className="btn-secondary" style={{ fontSize: 11.5, padding: '5px 12px', opacity: resTable.page === resTable.totalPages ? .5 : 1 }} disabled={resTable.page === resTable.totalPages} onClick={() => setResPage(p => Math.min(resTable.totalPages, p + 1))}>
                  Next<i className="fa-solid fa-chevron-right" style={{ marginLeft: 4 }} />
                </button>
              </div>
            )}
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
              <input type="date" className="form-input" style={{ width: 'auto', height: 28, fontSize: 12, padding: '0 8px' }} title="Jump to week containing this date" onChange={e => { if (e.target.value) setMasterWeekOffset(weekOffsetForDate(e.target.value)); }} />
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569' }}><span style={{ width: 14, height: 14, background: '#CCFBF1', borderRadius: 3, display: 'inline-block' }} />OT Session</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569' }}><span style={{ width: 14, height: 14, background: '#CFFAFE', borderRadius: 3, display: 'inline-block' }} />Speech Session</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569' }}><span style={{ width: 14, height: 14, background: '#FEF9C3', borderRadius: 3, display: 'inline-block' }} />Pending Parent Booking</div>
              <div style={{ fontSize: 12, color: '#94A3B8', marginLeft: 'auto' }}><i className="fa-solid fa-calendar-week" style={{ marginRight: 5 }} />Week of {master.weekLabel}</div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════ EMPLOYEE SCHEDULING ═══════════════ */}
      <div style={{ display: tab === 'scheduling' ? '' : 'none' }}>
        {/* Clinic operating hours, editable here since it's the same context as shift scheduling */}
        <div className="card" style={{ padding: '22px 24px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <div><div className="section-title">Clinic Operating Hours</div><div className="section-sub">Drives Initial Assessment availability, independent of any single therapist's shift</div></div>
            <button className="btn-primary" onClick={saveOperatingHours} disabled={hoursSaving}>
              <i className={'fa-solid ' + (hoursSaving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 4 }} />{hoursSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="form-label">Weekdays (Mon–Fri) Opens</label>
              <select className="form-select" value={operatingHours.clinic_weekday_start_hour} onChange={e => setOperatingHours(h => ({ ...h, clinic_weekday_start_hour: parseInt(e.target.value, 10) }))}>
                {CLINIC_HOURS.slice(0, -1).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Weekdays (Mon–Fri) Closes</label>
              <select className="form-select" value={operatingHours.clinic_weekday_end_hour} onChange={e => setOperatingHours(h => ({ ...h, clinic_weekday_end_hour: parseInt(e.target.value, 10) }))}>
                {CLINIC_HOURS.filter(h => h > operatingHours.clinic_weekday_start_hour).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Saturday Opens</label>
              <select className="form-select" value={operatingHours.clinic_saturday_start_hour} onChange={e => setOperatingHours(h => ({ ...h, clinic_saturday_start_hour: parseInt(e.target.value, 10) }))}>
                {CLINIC_HOURS.slice(0, -1).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Saturday Closes</label>
              <select className="form-select" value={operatingHours.clinic_saturday_end_hour} onChange={e => setOperatingHours(h => ({ ...h, clinic_saturday_end_hour: parseInt(e.target.value, 10) }))}>
                {CLINIC_HOURS.filter(h => h > operatingHours.clinic_saturday_start_hour).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 10, marginBottom: 18 }}>
            <i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Initial Assessment slots are generated straight from these hours, clinic-wide, capped at 1 per hour, since intake doesn't have a dedicated therapist yet. Every other session type still follows each therapist's own shift below. Sunday is always closed clinic-wide.
          </div>

          {/* Holidays/closures, specific one-off dates, blocks ALL booking types that day */}
          <div style={{ paddingTop: 16, borderTop: '1px solid #F1F5F9' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>Holidays &amp; Closures</div>
            <div className="section-sub" style={{ marginBottom: 12 }}>Specific dates the clinic is entirely closed, no bookings of any kind are allowed that day</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <input type="date" className="form-input" style={{ width: 'auto' }} min={todayPH()} value={newHolidayDate} onChange={e => setNewHolidayDate(e.target.value)} />
              <input className="form-input" style={{ flex: 1, minWidth: 160 }} placeholder="Reason (optional), e.g. Christmas Day" value={newHolidayLabel} onChange={e => setNewHolidayLabel(e.target.value)} />
              <button className="btn-primary" onClick={addHoliday} disabled={holidaySaving}>
                <i className={'fa-solid ' + (holidaySaving ? 'fa-spinner fa-spin' : 'fa-plus')} style={{ marginRight: 4 }} />Add Closure
              </button>
            </div>
            {holidays.length === 0 ? (
              <div style={{ fontSize: 12.5, color: '#94A3B8' }}>No upcoming closures scheduled.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {holidays.map(h => (
                  <div key={h.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px', borderRadius: 8, background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                    <div style={{ fontSize: 12.5 }}>
                      <span style={{ fontWeight: 700, color: '#0F172A' }}>{fmtShort(h.date)}</span>
                      {h.label && <span style={{ color: '#64748B' }}> · {h.label}</span>}
                    </div>
                    <button className="btn-edit" style={{ fontSize: 11, color: '#DC2626' }} onClick={() => removeHoliday(h.id)}><i className="fa-solid fa-trash" style={{ marginRight: 4 }} />Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

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

        {/* ── Admin & Staff availability, same tracking as therapists above, purely
             informational, it never affects booking capacity/slot generation. ── */}
        <div className="sched-grid" style={{ marginTop: 16 }}>
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9' }}>
              <div className="section-title">Admin &amp; Staff Shift Schedules</div>
              <div className="section-sub">Front-desk/admin availability, for schedule visibility only</div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th style={{ paddingLeft: 24 }}>Name</th><th>Role</th><th>Shift Start</th><th>Shift End</th><th>Lunch Break</th><th>Status</th><th style={{ paddingRight: 24, textAlign: 'right' }}>Actions</th></tr></thead>
                <tbody>
                  {adminShifts.length === 0 ? (
                    <tr><td colSpan={7} style={{ textAlign: 'center', padding: '28px 24px', color: '#94A3B8', fontSize: 12.5 }}>No admin/staff accounts yet.</td></tr>
                  ) : adminShifts.map(s => (
                    <tr key={s.therapist_id}><td style={{ paddingLeft: 24 }}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="act-avatar" style={{ width: 30, height: 30, background: s.bg, color: s.color, fontSize: 11 }}>{s.initials}</div><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{s.name}</div></div></td><td style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{s.role}</td><td>{s.start}</td><td>{s.end}</td><td style={{ color: s.lunch === '—' ? '#94A3B8' : '#0F172A' }}>{s.lunch}</td><td><span className={s.statusPill}>{s.status}</span></td><td style={{ paddingRight: 24, textAlign: 'right' }}><button className="btn-edit" onClick={() => openModal('edit-shift', { name: s.name, start_hour: s.start_hour, end_hour: s.end_hour, lunch_start_hour: s.lunch_start_hour, lunch_end_hour: s.lunch_end_hour, isInformational: true, onSave: patch => saveAdminShift(s.therapist_id, patch) })}>Edit Shift</button></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: '10px 24px 16px', fontSize: 11.5, color: '#94A3B8' }}>
              <i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Admin/staff shifts are informational only, they don't add booking slots or affect client capacity.
            </div>
          </div>

          <div className="card" style={{ padding: '22px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div><div className="section-title">Admin &amp; Staff Availability Matrix</div><div className="section-sub">Manage admin/staff day-off availability</div></div>
              <button className="btn-primary" onClick={saveAdminMatrix} disabled={adminMatrixSaving}><i className={'fa-solid ' + (adminMatrixSaving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} style={{ marginRight: 4 }} />{adminMatrixSaving ? 'Saving…' : 'Save'}</button>
            </div>
            <div style={{ overflowX: 'auto', marginBottom: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    <th style={{ padding: '8px 10px', textAlign: 'left', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Name</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Mon</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Tue</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Wed</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Thu</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Fri</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Sat</th>
                    <th style={{ padding: '8px 6px', textAlign: 'center', color: '#64748B', fontWeight: 600, borderBottom: '1px solid #E2E8F0' }}>Sun</th>
                  </tr>
                </thead>
                <tbody>
                  {adminShifts.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: '24px 10px', color: '#94A3B8', fontSize: 12 }}>No admin/staff accounts yet.</td></tr>
                  ) : adminShifts.map((s, rowIdx) => (
                    <tr key={s.therapist_id} style={rowIdx % 2 === 1 ? { background: '#F8FAFC' } : undefined}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: '#0F172A', fontSize: 12 }}>{s.name}</td>
                      {daysForAdmin(s).map((working, dayIdx) => (
                        <td key={dayIdx} style={{ textAlign: 'center', padding: 6 }}><span className="avail-dot" style={{ background: working ? DOT_COLORS.available : DOT_COLORS.off }} onClick={() => toggleAdminDay(s, dayIdx)} title={working ? 'Available, click to set day off' : 'Day off, click to set available'} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#64748B' }}><span className="avail-dot" style={{ background: '#22C55E', pointerEvents: 'none', width: 12, height: 12 }} /> Available</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#64748B' }}><span className="avail-dot" style={{ background: '#E2E8F0', pointerEvents: 'none', width: 12, height: 12 }} /> Day off</div>
            </div>
          </div>
        </div>
      </div>

      </>
      )}

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Booking and Appointment Module</span></div>

      {/* ══════════ Page-local modals ══════════ */}
      {modal && modal.kind === 'booking' && (
        <BookingModal key={bookingModalResetKey} selected={selected} daySlots={daySlots} slotState={slotState} defaultTime={modal.defaultTime} time={modal.time} clients={clients} clientLabel={clientLabel} serviceType={bookingServiceType} busy={busy} onClose={closeModal} onConfirm={confirmBooking} />
      )}
      {/* Slot-already-taken confirm, rendered on top of the booking modal
         (higher z-index) rather than replacing it, so "No" can dismiss back
         to the exact same form instead of losing it. */}
      {bookingConflict && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', zIndex: 250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '28px 26px', maxWidth: 400, width: '100%', textAlign: 'center', boxShadow: '0 24px 48px rgba(15,23,42,.25)' }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--color-warning-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <i className="fa-solid fa-triangle-exclamation" style={{ fontSize: 22, color: 'var(--color-warning)' }} />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>That Slot Is Already Booked</div>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 22, lineHeight: 1.6 }}>{bookingConflict.message} Do you want to continue and pick a different time or client?</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn-secondary" onClick={cancelAfterConflict}>No, Go Back</button>
              <button className="btn-primary" onClick={continueAfterConflict}>Yes, Continue</button>
            </div>
          </div>
        </div>
      )}
      {modal && modal.kind === 'slot' && (
        <SlotActionsModal selected={selected} daySlots={daySlots} time={modal.time} reservation={modal.reservation} busy={busy} onClose={closeModal} onReschedule={rescheduleSlot} onCancel={cancelSlot} onNoShow={noShowSlot} onEndSession={endSessionSlot} />
      )}
      {viewBooking && (() => {
        const r = viewBooking;
        const invoice = r.payments?.[0];
        const row = (label, value) => (
          <div>
            <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{value || '-'}</div>
          </div>
        );
        return (
          <Modal title={<><i className="fa-solid fa-calendar-check" style={{ color: '#16A34A', marginRight: 8 }} />Booking Details</>} onClose={() => setViewBooking(null)} width={460}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{r.clients?.full_name || '-'}</div>
              <span className={'pill ' + STATUS_PILL.confirmed.cls}>{STATUS_PILL.confirmed.label}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {row('Client ID', r.clients?.client_code)}
              {row('Session Type', r.session_type)}
              {row('Date & Time', fmtShort(r.date) + ' · ' + r.time_slot)}
              {row('Therapist', r.therapist_name)}
              {row('Duration', r.duration_min ? r.duration_min + ' minutes' : null)}
              {row('Guardian', r.clients?.guardian_name)}
              {row('Guardian Phone', r.clients?.guardian_phone)}
              {row('Channel', r.channel === 'parent-portal' ? 'Parent Portal' : 'Staff-Entered')}
              {invoice && row('Invoice No.', invoice.invoice_no)}
              {invoice && row('Amount', '₱' + Number(invoice.amount).toLocaleString())}
              {invoice && row('Method', invoice.method)}
              {invoice && row('Payment Status', invoice.status)}
              {invoice?.paid_at && row('Paid On', fmtShort(invoice.paid_at.slice(0, 10)))}
            </div>
            {r.notes && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #F1F5F9' }}>
                <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 4 }}>Notes</div>
                <div style={{ fontSize: 12.5, color: '#334155' }}>{r.notes}</div>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button className="btn-secondary" onClick={() => setViewBooking(null)}>Close</button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

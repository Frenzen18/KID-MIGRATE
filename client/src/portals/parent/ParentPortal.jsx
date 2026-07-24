import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { api, getToken } from '../../api.js';
import { useToast, Modal } from '../../components/ui.jsx';
import BrandLogo from '../../components/BrandLogo.jsx';
import GasProgressChart from '../../components/GasProgressChart.jsx';
import DevFunctionalField, { devFieldHidden } from '../../components/DevFunctionalField.jsx';
import { effectiveSlotAvailable } from '../admin/pages/reservations/reservationsHelpers.js';
import { formatPhoneDisplay } from '../../phoneInput.js';
import { sanitizeNameInput, hasInvalidNameChars, INVALID_NAME_MSG } from '../../nameInput.js';
import { filterSafeTextInput, hasUnsafeTextChars, UNSAFE_TEXT_MSG } from '../../textInput.js';
import './parent.css';

/* ── Constants ── */
/* Time slots come from /reservations/slots, generated hourly from therapist
   shifts, each with a capacity = number of therapists on shift at that hour. */

function fmtDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtShortDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
/** Calendar age (not a 365.25-day average, that rounds down near a birthday and
 *  could reject someone turning exactly 18/3/21 today). Expects "YYYY-MM-DD". */
function getAge(dob) {
  if (!dob) return null;
  const [y, m, d] = String(dob).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const today = new Date();
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age--;
  return age;
}

/* ── Child intake form constants ──
   Deliberately minimal (RA 10173 data minimization): diagnosis, medical
   conditions, and therapy type are assessed and set by the clinic, not
   collected from the parent at registration. */
const EMPTY_LINK_FORM = {
  first_name: '', middle_name: '', last_name: '', dob: '', gender: '', allergies: '', daily_medication: '',
  guardian_relationship: 'Parent', guardian_dob: '',
  other_guardian_phone: '+63',
  // Development & Functional Information, optional, admin-configurable form;
  // keyed by dev_functional_fields.id (see EMPTY_LINK_FORM usage + dev-functional-fields fetch).
  dev_functional_data: {}
};

// Philippine mobile number: +639XXXXXXXXX only
const PH_PHONE = /^\+639\d{9}$/;

/* Patients must be 3–21 years old. */
function maxPatientDob() { // youngest allowed: exactly 3 years old
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d.toISOString().slice(0, 10);
}
function minPatientDob() { // oldest allowed: 21 (not yet 22)
  const d = new Date();
  d.setFullYear(d.getFullYear() - 22);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/* Guardian/caretaker must be an adult (18–120 years old). */
function maxGuardianDob() { // youngest allowed: exactly 18 years old
  const d = new Date();
  d.setFullYear(d.getFullYear() - 18);
  return d.toISOString().slice(0, 10);
}
function minGuardianDob() { // oldest allowed: 120 (not yet 121)
  const d = new Date();
  d.setFullYear(d.getFullYear() - 121);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function initials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
function todayStr() {
  // Philippine time (UTC+8), not the browser's local timezone.
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
/** Earliest bookable date, bookings must be made at least a day ahead, same-day isn't allowed. */
function minBookableDateStr() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
/** Session types a child is currently eligible to book: intake (no therapy type
 *  and no assigned therapist yet) means only an Initial Assessment can be
 *  requested, once assigned, only sessions matching that discipline (or both,
 *  for a Combined program) become available. */
function sessionTypesFor(child) {
  if (!child) return [];
  if (!child.assigned_ot_therapist_name && !child.assigned_speech_therapist_name && !child.therapy_type) return ['Initial Assessment'];
  const map = { OT: ['Occupational Therapy'], Speech: ['Speech Therapy'], Both: ['Occupational Therapy', 'Speech Therapy'] };
  return map[child.therapy_type] || ['Initial Assessment'];
}
/** Which discipline a session type belongs to, null for discipline-agnostic types (e.g. Initial Assessment). */
function disciplineOfType(type) {
  if (type === 'Occupational Therapy' || type === 'Occupational Assessment') return 'ot';
  if (type === 'Speech Therapy' || type === 'Speech-Language Assessment') return 'speech';
  return null;
}
/** Current time in the Philippines (UTC+8), regardless of the device's local timezone. */
function nowPH() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000);
}
/** True if the given "h:mm AM/PM" slot on `dateStr` has already passed in PH time. */
function isSlotPast(dateStr, timeLabel) {
  if (!dateStr || dateStr > todayStr()) return false;
  if (dateStr < todayStr()) return true;
  const m = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(timeLabel.trim());
  if (!m) return false;
  let [, h, min, ap] = m;
  h = parseInt(h, 10) % 12;
  if (/pm/i.test(ap)) h += 12;
  const slotMinutes = h * 60 + parseInt(min, 10);
  const now = nowPH();
  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return slotMinutes <= nowMinutes;
}

/* ── Booking date-picker (calendar) helpers, string-based ("YYYY-MM"/"YYYY-MM-DD")
   to avoid local-timezone drift from constructing Date objects for arithmetic. ── */
function ymFromDateStr(dateStr) { return dateStr.slice(0, 7); }
function addMonths(ym, delta) {
  let [y, m] = ym.split('-').map(Number);
  m += delta;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return y + '-' + String(m).padStart(2, '0');
}
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function firstWeekdayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).getDay(); // 0 = Sunday
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** All page keys the sidebar can navigate to, used to validate the page restored from localStorage on reload. */
const PARENT_PAGE_KEYS = ['dashboard', 'booking', 'payment', 'notifications'];

export default function ParentPortal() {
  const { logout, user, updateUser, updateProfile } = useAuth();
  const nav = useNavigate();
  const toast = useToast();

  /* ── Navigation state ── */
  const [page, setPage] = useState(() => {
    const saved = localStorage.getItem('kid_parent_page');
    return PARENT_PAGE_KEYS.includes(saved) ? saved : 'dashboard';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  /* ── Branding, used on the printable invoice letterhead below ── */
  const [brand, setBrand] = useState(null);
  useEffect(() => { fetch('/api/settings/branding/public').then(r => r.json()).then(setBrand).catch(() => {}); }, []);

  /* ── My Profile modal, self-service contact number edit ── */
  const [profileModal, setProfileModal] = useState(false);
  const [contactInput, setContactInput] = useState('+63');
  const [contactErr, setContactErr] = useState('');
  const [contactSaving, setContactSaving] = useState(false);

  /* ── Data state ── */
  const [children, setChildren] = useState(null); // null = loading
  const [activeChild, setActiveChild] = useState(null); // full child detail with session_notes + attendance
  const [photoUploading, setPhotoUploading] = useState(false);
  const [reservations, setReservations] = useState(null);
  const [payments, setPayments] = useState(null);
  const [notifications, setNotifications] = useState(null);
  const [loading, setLoading] = useState(true);
  // Clinic-wide closures (holidays), so "no time slots" can explain why instead
  // of just looking broken, no booking of any kind is allowed on one.
  const [holidays, setHolidays] = useState([]);
  useEffect(() => { api('/settings/holidays?from=' + todayStr()).then(setHolidays).catch(() => {}); }, []);
  // Development & Functional Information, the admin-configurable field list
  // rendered on the child-linking form (see server/routes/devFunctionalFields.js).
  const [devFields, setDevFields] = useState([]);

  /* ── Booking page state ── */
  const [reservationDate, setReservationDate] = useState(minBookableDateStr());
  const [calMonth, setCalMonth] = useState(() => ymFromDateStr(minBookableDateStr()));
  const [selectedSlot, setSelectedSlot] = useState('');
  const [slotsForDate, setSlotsForDate] = useState([]);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [slotError, setSlotError] = useState(false);
  const [bookingConfirm, setBookingConfirm] = useState(false);
  const [bookingSessionType, setBookingSessionType] = useState('');

  /* ── Progress page state ── */

  /* ── Payment page state ── */
  const [payTab, setPayTab] = useState(() => {
    const saved = localStorage.getItem('kid_parent_pay_tab');
    return saved === 'checkout' || saved === 'receipts' ? saved : 'checkout';
  });
  useEffect(() => { localStorage.setItem('kid_parent_pay_tab', payTab); }, [payTab]);

  /* ── Notifications page state ── */
  const [notifTab, setNotifTab] = useState('reminders');

  /* ── Real QRPh checkout (PayMongo), self-serve, one invoice at a time ── */
  const [qrModal, setQrModal] = useState(null); // { payment, image, expiresAt, testUrl, status }
  const [qrBusy, setQrBusy] = useState(false);
  const [invoice, setInvoice] = useState(null);
  function printInvoice() { window.print(); }

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
          toast('Payment received, your booking is confirmed', 'fa-circle-check');
          const fresh = await api('/payments').catch(() => null);
          if (fresh) setPayments(fresh);
          // The held slot only becomes 'confirmed' once payment succeeds (see
          // markPaidByIntentId, server/lib/paymongoWebhook.js), refresh so the
          // booking list drops the "Awaiting Payment" state immediately.
          const freshRes = await api('/reservations').catch(() => null);
          if (freshRes) setReservations(freshRes);
        }
      } catch { /* transient poll failure, try again next tick */ }
    }, 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrModal?.payment?.id, qrModal?.status]);
  const [linkChildModal, setLinkChildModal] = useState(false);
  const [linkForm, setLinkForm] = useState(EMPTY_LINK_FORM);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState('');
  // The intake form is broken into steps (Child → Guardian → Development &
  // Functional) so it doesn't read as one huge scroll, still one submission at the end.
  const [linkStep, setLinkStep] = useState(1);
  // Live per-field notes for the phone inputs (e.g. "numbers only" when letters are typed)
  const [phoneNotes, setPhoneNotes] = useState({});
  const [nameNotes, setNameNotes] = useState({});
  const [textNotes, setTextNotes] = useState({});
  // First-login onboarding: when the parent has no child linked yet, the
  // intake modal opens automatically with a welcome framing.
  const [onboarding, setOnboarding] = useState(false);
  // RA 10173: the intake form is gated behind a data-privacy consent screen.
  const [linkConsent, setLinkConsent] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  // Ticks every 30s so same-day time slots gray out live (PH time) as the clock passes them.
  const [, forceClockTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => forceClockTick(t => t + 1), 30000);
    return () => clearInterval(iv);
  }, []);

  /* ── Fetch all data on mount ── */
  useEffect(() => {
    async function load() {
      try {
        const [childrenData, resData, payData, notifData, devFieldsData] = await Promise.all([
          api('/clients').catch(() => []),
          api('/reservations').catch(() => []),
          api('/payments').catch(() => []),
          api('/notifications').catch(() => []),
          api('/dev-functional-fields').catch(() => [])
        ]);
        setChildren(childrenData || []);
        setReservations(resData || []);
        setPayments(payData || []);
        setNotifications(notifData || []);
        setDevFields(devFieldsData || []);

        // If parent has children, load the first child's full details
        if (childrenData && childrenData.length > 0) {
          const detail = await api('/clients/' + childrenData[0].id).catch(() => childrenData[0]);
          setActiveChild(detail);
        } else {
          // No child yet, guide the parent through the intake form right away
          setOnboarding(true);
          setLinkChildModal(true);
        }
      } catch (e) {
        console.error('Failed to load portal data:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  /* ── Keep the active child's record fresh ──
     Admin/staff/therapist edits (e.g. Development & Functional Information,
     booking status changes, payments, notifications) happen outside this
     session entirely, so without polling the parent would only ever see what
     was loaded at login. Same 30s cadence already used elsewhere in this
     portal (clock tick, etc.), not true push, but close enough that a
     change shows up within moments instead of requiring a logout.
     Failures are swallowed silently and simply keep the last-known-good
     data on screen (no flicker to empty on a transient network blip). */
  useEffect(() => {
    if (!activeChild?.id) return;
    const iv = setInterval(() => {
      api('/clients/' + activeChild.id).then(setActiveChild).catch(() => {});
      api('/reservations').then(setReservations).catch(() => {});
      api('/payments').then(setPayments).catch(() => {});
      api('/notifications').then(setNotifications).catch(() => {});
    }, 30000);
    return () => clearInterval(iv);
  }, [activeChild?.id]);

  /* ── Fetch slot availability when booking date (or the active child) changes ──
     client_id lets the server narrow slots to the child's own Assigned Therapist,
     if one is set, instead of the clinic's combined capacity. */
  useEffect(() => {
    if (!reservationDate) return;
    let cancelled = false;
    const child = activeChild || children?.[0];
    const qs = 'date=' + reservationDate + (child?.id ? '&client_id=' + child.id : '')
      + (bookingSessionType ? '&session_type=' + encodeURIComponent(bookingSessionType) : '');
    api('/reservations/slots?' + qs)
      .then(data => { if (!cancelled) setSlotsForDate(data); })
      .catch(() => { if (!cancelled) setSlotsForDate([]); });
    return () => { cancelled = true; };
  }, [reservationDate, activeChild, children, bookingSessionType]);

  /* ── Keep the selected session type in sync with what the child is actually
     eligible for, defaulting to the only option, or the first, whenever the
     eligible set changes (e.g. staff just assigned a therapy type). ── */
  useEffect(() => {
    const child = activeChild || children?.[0];
    const options = sessionTypesFor(child);
    setBookingSessionType(prev => (options.includes(prev) ? prev : (options[0] || '')));
  }, [activeChild, children]);

  /* ── Close dropdown panels on outside click ── */
  useEffect(() => {
    function onDoc(e) {
      if (!e.target.closest('#notif-btn') && !e.target.closest('#notif-panel')) setNotifOpen(false);
      if (!e.target.closest('#profile-btn') && !e.target.closest('#profile-panel')) setProfileOpen(false);
    }
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  /* ── Helpers ── */
  function goPage(key) { setPage(key); localStorage.setItem('kid_parent_page', key); setSidebarOpen(false); window.scrollTo(0, 0); }
  function toggleNotif() { setProfileOpen(false); setNotifOpen(o => !o); }
  function toggleProfile() { setNotifOpen(false); setProfileOpen(o => !o); }
  function doLogout() { logout(); nav('/login'); }

  /* ── Idle session timeout (Guardian/Caretaker portal only) ──
     After 5 minutes with no mouse/keyboard/touch activity, warn instead of
     silently logging out, since a guardian mid-read shouldn't just get
     yanked back to the login screen with no chance to say "I'm still here".
     A 60s countdown follows the warning, if nothing's clicked by the end of
     that, it logs out for real, same as a shared/public clinic computer
     should behave. */
  const IDLE_WARNING_AFTER_MS = 5 * 60 * 1000;
  const IDLE_COUNTDOWN_SECONDS = 60;
  const [idleWarning, setIdleWarning] = useState(false);
  const [idleCountdown, setIdleCountdown] = useState(IDLE_COUNTDOWN_SECONDS);
  const idleTimerRef = useRef(null);
  const countdownIntervalRef = useRef(null);
  // Mirrors idleWarning for the activity listener below, that listener is
  // attached once on mount, so it needs a ref (not the state itself) to see
  // the current value instead of forever reading whatever it was at mount.
  const idleWarningRef = useRef(false);
  useEffect(() => { idleWarningRef.current = idleWarning; }, [idleWarning]);

  function clearCountdown() {
    if (countdownIntervalRef.current) { clearInterval(countdownIntervalRef.current); countdownIntervalRef.current = null; }
  }

  function startCountdown() {
    clearCountdown();
    setIdleCountdown(IDLE_COUNTDOWN_SECONDS);
    countdownIntervalRef.current = setInterval(() => {
      setIdleCountdown(s => {
        if (s <= 1) {
          clearCountdown();
          doLogout();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  function resetIdleTimer() {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setIdleWarning(true);
      startCountdown();
    }, IDLE_WARNING_AFTER_MS);
  }

  function stayLoggedIn() {
    setIdleWarning(false);
    clearCountdown();
    resetIdleTimer();
  }

  useEffect(() => {
    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    // Only real activity counts, once the warning modal is up, only its own
    // "Continue Session" button (stayLoggedIn) should clear it, not just
    // moving the mouse over the overlay.
    function onActivity() { if (!idleWarningRef.current) resetIdleTimer(); }
    activityEvents.forEach(evt => window.addEventListener(evt, onActivity));
    resetIdleTimer();
    return () => {
      activityEvents.forEach(evt => window.removeEventListener(evt, onActivity));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      clearCountdown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markNotifRead(id) {
    try {
      await api('/notifications/' + id + '/read', { method: 'PUT' });
      setNotifications(prev => (prev || []).map(n => n.id === id ? { ...n, read: true } : n));
    } catch (e) { /* silent, same as the dashboard/staff/therapist bell dropdowns */ }
  }

  /* Visiting the Notifications page is itself "reading" the inbox, mark
     everything read automatically instead of requiring a manual click per
     item, same behavior as the shared admin/staff/therapist inbox page. */
  useEffect(() => {
    if (page !== 'notifications') return;
    if (!(notifications || []).some(n => !n.read)) return;
    api('/notifications/read-all', { method: 'PUT' })
      .then(() => setNotifications(prev => (prev || []).map(n => ({ ...n, read: true }))))
      .catch(() => {});
  }, [page]);

  function openProfileModal() {
    setProfileOpen(false);
    setContactInput(user?.contact || '+63');
    setContactErr('');
    setProfileModal(true);
  }

  /** Live phone input: keep only digits after "+63", flag letters immediately, same pattern as the child-intake form. */
  function handleContactInput(e) {
    const raw = e.target.value;
    const hadLetters = /[A-Za-z]/.test(raw);
    const rest = raw.startsWith('+63') ? raw.slice(3) : raw.replace(/^\+?6?3?/, '');
    const digits = rest.replace(/\D/g, '').slice(0, 10);
    setContactErr(hadLetters ? 'Numbers only, letters are not allowed.' : '');
    setContactInput(`+63${digits}`);
  }

  async function saveContact() {
    if (!PH_PHONE.test(contactInput)) { setContactErr('Phone number must be +63 followed by 10 digits (e.g. +63 917 123 4567).'); return; }
    setContactSaving(true);
    try {
      await updateProfile({ contact: contactInput });
      toast('Phone number updated', 'fa-circle-check');
      setProfileModal(false);
    } catch (e) {
      setContactErr(e.message || 'Failed to update phone number');
    } finally {
      setContactSaving(false);
    }
  }

  const unreadNotifs = (notifications || []).filter(n => !n.read);
  const unreadCount = unreadNotifs.length;

  /* ── Derived data ── */
  const pendingPayments = (payments || []).filter(p => p.status === 'pending' || p.status === 'overdue');
  const paidPayments = (payments || []).filter(p => p.status === 'paid');
  const refundedPayments = (payments || []).filter(p => p.status === 'refunded');
  // A booking only still "blocks" a new one while it hasn't happened yet, once its own
  // slot time has passed (even earlier today) it's finished, same as any other past date.
  // This spans every linked child, callers that gate on "does THIS child already
  // have a booking" must filter it down by client_id (see upcomingReservationsFor)
  // instead of using it directly, one child's booking must never block another's.
  const upcomingReservations = (reservations || []).filter(r => r.date >= todayStr() && !isSlotPast(r.date, r.time_slot) && ['awaiting_payment', 'pending', 'confirmed', 'rescheduled'].includes(r.status));
  function upcomingReservationsFor(childId) {
    return childId ? upcomingReservations.filter(r => r.client_id === childId) : [];
  }

  /* ── Booking handlers ── */
  function pickSlot(label) { setSelectedSlot(label); setSlotError(false); }
  function changeDate(val) { setReservationDate(val); setSelectedSlot(''); setSlotError(false); }
  /** Pre-submit checks shared by the "Book" button (before opening the
   *  confirmation modal) and the modal's own confirm step (re-checked there
   *  too, in case something changed - e.g. the slot filled up - while the
   *  modal was open). Returns false and surfaces the reason via toast/slotError. */
  function validateBooking() {
    if (!reservationDate) {
      toast('Please select a reservation date.', 'fa-triangle-exclamation');
      return false;
    }
    if (!selectedSlot) {
      toast('Please select a time slot before submitting.', 'fa-triangle-exclamation');
      setSlotError(true);
      return false;
    }
    if (isSlotPast(reservationDate, selectedSlot)) {
      toast('That time slot has already passed. Please pick another.', 'fa-triangle-exclamation');
      setSelectedSlot('');
      return false;
    }
    if (!children || !children.length) {
      toast('No child linked to your account yet', 'fa-circle-exclamation');
      return false;
    }
    if (!bookingSessionType) {
      toast('Please select a session type before submitting.', 'fa-triangle-exclamation');
      return false;
    }
    // A Combined child may hold one OT session AND one Speech session at once,
    // so this only blocks a second booking within the same discipline, mirrors
    // the same exception the render side (hasActiveBooking) and the server apply.
    const bookingChildForCheck = activeChild || children[0];
    const checkDiscipline = disciplineOfType(bookingSessionType);
    const childReservations = upcomingReservationsFor(bookingChildForCheck?.id);
    const conflictingBooking = (bookingChildForCheck?.therapy_type === 'Both' && checkDiscipline)
      ? childReservations.find(r => disciplineOfType(r.session_type) === checkDiscipline)
      : childReservations[0];
    if (conflictingBooking) {
      toast('You already have an upcoming booking for this child. You can only book one at a time, cancel it under "My Booking Requests", or wait until its date has passed, before submitting a new one.', 'fa-triangle-exclamation');
      return false;
    }
    // Two siblings booked into the same discipline at the exact same date+time
    // would need the same kind of specialist at once, that's the real
    // conflict, not the date+time alone. Different disciplines (e.g. one
    // sibling's Initial Assessment and another's Occupational Therapy) are
    // separate processes and can share the same slot just fine.
    const siblingConflict = checkDiscipline
      ? upcomingReservations.find(r => r.client_id !== bookingChildForCheck?.id && r.date === reservationDate && r.time_slot === selectedSlot && disciplineOfType(r.session_type) === checkDiscipline)
      : null;
    if (siblingConflict) {
      const siblingName = siblingConflict.clients?.full_name || children.find(c => c.id === siblingConflict.client_id)?.full_name || 'one of your other children';
      toast(`${siblingName} already has a session booked at ${selectedSlot} on ${fmtDate(reservationDate)}. Please pick a different time.`, 'fa-triangle-exclamation');
      return false;
    }
    return true;
  }
  function openBookingConfirm() {
    if (bookingBusy) return; // guard against double-click / double-submit race
    if (!validateBooking()) return;
    setBookingConfirm(true);
  }
  async function confirmSubmitReservation() {
    if (bookingBusy) return;
    if (!validateBooking()) { setBookingConfirm(false); return; }
    // The guardian may have more than one child linked and picked a specific
    // one via the "Booking For" selector, activeChild reflects that choice,
    // children[0] is only a fallback for the brief moment before it's set.
    const bookingChildId = (activeChild || children[0]).id;
    setBookingBusy(true);
    try {
      const { payment, ...res } = await api('/reservations', {
        method: 'POST',
        body: {
          date: reservationDate,
          time_slot: selectedSlot,
          client_id: bookingChildId,
          session_type: bookingSessionType
        }
      });
      setReservations(prev => [...(prev || []), res]);
      setSelectedSlot('');
      setBookingConfirm(false);
      // Refresh slots, same client_id/session_type as the booking above, so the
      // list stays narrowed to that child's Assigned Therapist if one is set.
      api('/reservations/slots?date=' + reservationDate + '&client_id=' + bookingChildId + '&session_type=' + encodeURIComponent(bookingSessionType)).then(setSlotsForDate).catch(() => {});
      toast('Slot held, complete payment to confirm your booking', 'fa-calendar-check');
      // No more staff-approved "request", the slot is held and this goes
      // straight to QRPh checkout, paying is what actually confirms it.
      if (payment) generateQr(payment);
    } catch (e) {
      toast(e.message || 'Failed to submit booking', 'fa-circle-exclamation');
      // Keep the modal open on failure (e.g. the slot filled up in the
      // meantime) so the parent can see the error and retry or back out.
    } finally {
      setBookingBusy(false);
    }
  }

  /** Cancel one of the guardian's own booking requests (e.g. before completing payment). */
  const [cancelTarget, setCancelTarget] = useState(null); // the reservation being confirmed for cancellation
  const [cancelBusy, setCancelBusy] = useState(false);
  async function confirmCancelReservation() {
    if (!cancelTarget) return;
    setCancelBusy(true);
    try {
      await api('/reservations/' + cancelTarget.id, { method: 'PUT', body: { status: 'cancelled' } });
      setReservations(prev => (prev || []).map(r => r.id === cancelTarget.id ? { ...r, status: 'cancelled' } : r));
      toast('Booking cancelled', 'fa-calendar-xmark');
      setCancelTarget(null);
    } catch (e) {
      toast(e.message || 'Failed to cancel booking', 'fa-circle-exclamation');
    } finally {
      setCancelBusy(false);
    }
  }

  /** Live phone input: keep only digits (and a leading +), flag letters immediately. */
  function handlePhoneInput(field) {
    return e => {
      const raw = e.target.value;
      const hadLetters = /[A-Za-z]/.test(raw);
      // Work only with the part after "+63" (however much of the prefix survived editing/selection).
      let rest = raw.startsWith('+63') ? raw.slice(3) : raw.replace(/^\+?6?3?/, '');
      const digits = rest.replace(/\D/g, '').slice(0, 10); // exactly 10 digits after +63
      setPhoneNotes(n => ({ ...n, [field]: hadLetters ? 'Numbers only, letters are not allowed.' : '' }));
      setLinkForm(f => ({ ...f, [field]: `+63${digits}` }));
    };
  }

  /** Live name input: letters/spaces/hyphens/apostrophes only, flag digits/symbols immediately. */
  function handleNameInput(field) {
    return e => {
      const raw = e.target.value;
      setNameNotes(n => ({ ...n, [field]: hasInvalidNameChars(raw) ? INVALID_NAME_MSG : '' }));
      setLinkForm(f => ({ ...f, [field]: sanitizeNameInput(raw) }));
    };
  }

  /** Live free-text input (Allergies, Daily Medication, ...): letters/numbers/common punctuation only, flag stray special characters immediately. */
  function handleTextInput(field) {
    return e => {
      const raw = e.target.value;
      setTextNotes(n => ({ ...n, [field]: hasUnsafeTextChars(raw) ? UNSAFE_TEXT_MSG : '' }));
      setLinkForm(f => ({ ...f, [field]: filterSafeTextInput(raw) }));
    };
  }

  /** Records the RA 10173 consent on the account so the notice is shown only once. */
  async function agreeConsent() {
    setLinkConsent(true);
    try {
      const r = await api('/auth/consent', { method: 'POST' });
      updateUser({ privacy_consent_at: r.consented_at });
    } catch {
      // Not fatal, if saving fails, the notice simply shows again next time.
    }
  }

  /** Step 1 (Child's Information) validation, returns an error string or null. */
  function validateChildStep() {
    if (!linkForm.first_name.trim() || !linkForm.last_name.trim()) return 'Child\'s first name and last name are required.';
    if (!linkForm.dob) return 'Date of birth is required.';
    const childAge = getAge(linkForm.dob);
    if (childAge < 0) return 'Date of birth cannot be in the future.';
    if (childAge < 3 || childAge > 21) return 'Patients must be between 3 and 21 years old.';
    if (!linkForm.gender) return 'Please select a gender.';
    return null;
  }

  /** Step 2 (Guardian/Caretaker Information) validation, returns an error string or null. */
  function validateGuardianStep() {
    if (!linkForm.guardian_dob) return 'Please enter your date of birth.';
    const gAge = getAge(linkForm.guardian_dob);
    if (gAge < 0) return 'Date of birth cannot be in the future.';
    if (gAge < 18 || gAge > 120) return 'Parent/guardian must be an adult (18 years old and above).';
    const altPhone = linkForm.other_guardian_phone === '+63' ? '' : linkForm.other_guardian_phone;
    if (altPhone && !PH_PHONE.test(altPhone)) return 'Alternate phone number must be +63 followed by 10 digits (e.g. +63 917 123 4567).';
    return null;
  }

  /** Step 3 (Development & Functional Information) validation: only admin-marked required fields, skips ones hidden by devFieldHidden. Returns an error string or null. */
  function validateDevFunctionalStep() {
    for (const f of devFields) {
      if (!f.required || devFieldHidden(f, devFields, linkForm.dev_functional_data)) continue;
      const val = linkForm.dev_functional_data[f.id];
      if (val == null || String(val).trim() === '') return `"${f.label}" is required.`;
    }
    return null;
  }

  function nextLinkStep() {
    setLinkErr('');
    const err = linkStep === 1 ? validateChildStep() : linkStep === 2 ? validateGuardianStep() : null;
    if (err) return setLinkErr(err);
    setLinkStep(s => s + 1);
  }
  function prevLinkStep() {
    setLinkErr('');
    setLinkStep(s => s - 1);
  }

  async function submitLinkChild() {
    // Extra safety net: the "Register Child" button only renders on step 3,
    // so this shouldn't be reachable any earlier, but bail rather than run
    // validation against fields the user hasn't even seen yet.
    if (linkStep !== 3) return;
    setLinkErr('');
    const childErr = validateChildStep();
    if (childErr) { setLinkStep(1); return setLinkErr(childErr); }
    const guardianErr = validateGuardianStep();
    if (guardianErr) { setLinkStep(2); return setLinkErr(guardianErr); }
    const devErr = validateDevFunctionalStep();
    if (devErr) { setLinkStep(3); return setLinkErr(devErr); }
    const guardPhone = user?.contact || '';
    const altPhone = linkForm.other_guardian_phone === '+63' ? '' : linkForm.other_guardian_phone;

    setLinkBusy(true);
    try {
      const res = await api('/clients/self-register', {
        method: 'POST',
        body: {
          ...linkForm,
          first_name: linkForm.first_name.trim(),
          last_name: linkForm.last_name.trim(),
          guardian_phone: guardPhone || '',
          other_guardian_phone: altPhone || '',
          guardian_name: user?.name || '',
          guardian_contact: guardPhone || ''
        }
      });
      // Add new child to local state
      setChildren(prev => [...(prev || []), res]);
      if (!activeChild) {
        const detail = await api('/clients/' + res.id).catch(() => res);
        setActiveChild(detail);
      }
      setLinkChildModal(false);
      setOnboarding(false);
      setLinkConsent(false);
      setConsentChecked(false);
      setLinkForm(EMPTY_LINK_FORM);
      setPhoneNotes({});
      setNameNotes({});
      setTextNotes({});
      setLinkStep(1);
      toast('Child profile registered successfully!', 'fa-check');
    } catch (ex) {
      setLinkErr(ex.message || 'Failed to register child.');
    } finally {
      setLinkBusy(false);
    }
  }



  /* ═══════════════════════════════════════════════════════════
     EMPTY STATE COMPONENT
     ═══════════════════════════════════════════════════════════ */
  function EmptyState({ icon, title, description }) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px' }}>
        <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <i className={'fa-solid ' + icon} style={{ fontSize: 28, color: '#94A3B8' }} />
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#334155', marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: '#64748B', maxWidth: 400, margin: '0 auto', lineHeight: 1.6 }}>{description}</div>
      </div>
    );
  }



  /** Switches which linked child the dashboard/booking/etc. show, for guardians with more than one. */
  const [childSwitching, setChildSwitching] = useState(false);
  async function switchChild(childId) {
    if (!childId || activeChild?.id === childId) return;
    const fallback = children?.find(c => c.id === childId);
    setChildSwitching(true);
    try {
      const detail = await api('/clients/' + childId).catch(() => fallback);
      if (detail) setActiveChild(detail);
    } finally {
      setChildSwitching(false);
    }
  }
  /** Same child switch as the dashboard's, plus clearing the currently
   *  selected time slot, it belonged to whichever child was active before,
   *  not necessarily one still open for the newly picked child. */
  function switchBookingChild(childId) {
    setSelectedSlot('');
    setSlotError(false);
    switchChild(childId);
  }

  /** Uploads (or replaces) the active child's profile photo, so their therapist can recognize their face. */
  async function uploadChildPhoto(childId, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please select an image file', 'fa-triangle-exclamation'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('Image must be under 5MB', 'fa-triangle-exclamation'); return; }
    setPhotoUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/clients/' + childId + '/photo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: formData
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || 'Upload failed');
      setChildren(prev => (prev || []).map(c => c.id === childId ? { ...c, photo_url: updated.photo_url } : c));
      setActiveChild(prev => prev && prev.id === childId ? { ...prev, photo_url: updated.photo_url } : prev);
      toast('Photo updated', 'fa-check');
    } catch (err) {
      toast('Upload failed: ' + err.message, 'fa-triangle-exclamation');
    } finally {
      setPhotoUploading(false);
      e.target.value = '';
    }
  }

  /* ═══════════════════════════════════════════════════════════
     DASHBOARD
     ═══════════════════════════════════════════════════════════ */
  function renderDashboard() {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const hasChildren = children && children.length > 0;

    if (!hasChildren) {
      return (
        <div className="spa-page" id="spa-dashboard">
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Welcome, {user?.name ? user.name.split(' ')[0] : 'there'} 👋</h1>
            <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}><i className="fa-regular fa-calendar" style={{ marginRight: 5 }} />{dateStr}</p>
          </div>
          <div className="card" style={{ padding: '40px 20px' }}>
            <EmptyState
              icon="fa-child"
              title="No Child Linked Yet"
              description="Your account doesn't have any child profiles linked yet. Register your child's information below to get started with booking sessions and tracking progress."
            />
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <div style={{ display: 'inline-flex', gap: 12 }}>
                <button onClick={() => setLinkChildModal(true)} style={{ padding: '12px 24px', background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="fa-solid fa-link" /> Link Your Child
                </button>
                <a href="#" onClick={e => { e.preventDefault(); goPage('notifications'); }} className="qa-btn" style={{ width: 'auto', padding: '12px 16px', fontSize: 13, textDecoration: 'none' }}><i className="fa-solid fa-bell" style={{ color: '#0EA5E9' }} /> Check Notifications</a>
              </div>
            </div>
          </div>
          <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · All rights reserved</span></div>
        </div>
      );
    }

    const child = activeChild || children[0];
    const age = getAge(child.dob);

    return (
      <div className="spa-page" id="spa-dashboard">
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Welcome back, {user?.name ? user.name.split(' ')[0] : 'there'} 👋</h1>
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}><i className="fa-regular fa-calendar" style={{ marginRight: 5 }} />{dateStr} &nbsp;·&nbsp; Here's an overview of {child.full_name}'s therapy journey.</p>
        </div>

        {/* Active child banner */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, padding: '18px 22px', borderRadius: 14, background: 'linear-gradient(135deg, var(--color-primary), var(--color-teal))', color: '#fff', overflow: 'hidden', boxShadow: '0 10px 28px rgba(15,23,42,.16)', flexWrap: 'wrap' }}>
          {/* Purely decorative depth, clipped by the banner's own overflow:hidden */}
          <div style={{ position: 'absolute', top: -46, right: -26, width: 170, height: 170, borderRadius: '50%', background: 'rgba(255,255,255,.10)', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', bottom: -56, right: 110, width: 120, height: 120, borderRadius: '50%', background: 'rgba(255,255,255,.07)', pointerEvents: 'none' }} />

          <label
            title="Upload your child's photo, so their therapist can recognize them"
            style={{ position: 'relative', width: 60, height: 60, flexShrink: 0, cursor: photoUploading ? 'default' : 'pointer', borderRadius: '50%', overflow: 'hidden', boxShadow: '0 0 0 3px rgba(255,255,255,.4), 0 4px 12px rgba(15,23,42,.18)' }}
          >
            {child.photo_url ? (
              <img src={child.photo_url} alt={child.full_name} style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
            ) : (
              <div className="act-avatar" style={{ background: 'rgba(255,255,255,.22)', color: '#fff', width: 60, height: 60, fontSize: 22 }}><i className="fa-solid fa-child" /></div>
            )}
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity .15s' }}
              onMouseEnter={e => { e.currentTarget.style.opacity = 1; }} onMouseLeave={e => { e.currentTarget.style.opacity = 0; }}>
              <i className={'fa-solid ' + (photoUploading ? 'fa-spinner fa-spin' : 'fa-camera')} style={{ fontSize: 14, color: '#fff' }} />
            </div>
            <input type="file" accept="image/*" disabled={photoUploading} onChange={e => uploadChildPhoto(child.id, e)} style={{ display: 'none' }} />
          </label>

          <div style={{ position: 'relative', flex: '1 1 160px', minWidth: 0 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', opacity: .85, marginBottom: 3 }}>
              <i className="fa-solid fa-star" style={{ fontSize: 9.5 }} />Active Child Profile
            </div>
            <div style={{ fontFamily: "'Poppins',sans-serif", fontSize: 19, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{child.full_name}</div>
          </div>

          <div style={{ position: 'relative', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'rgba(255,255,255,.18)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
              <i className="fa-solid fa-id-card" style={{ fontSize: 10 }} />{child.client_code}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'rgba(255,255,255,.18)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
              <i className="fa-solid fa-hand-holding-heart" style={{ fontSize: 10 }} />{child.therapy_type ? child.therapy_type + ' Program' : 'For assessment'}
            </span>
            {age ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 20, background: 'rgba(255,255,255,.18)', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
                <i className="fa-solid fa-cake-candles" style={{ fontSize: 10 }} />Age {age}
              </span>
            ) : null}
          </div>
        </div>

        {/* Switch between linked children (only shown once there's more than one) + link another */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
          {children.length > 1 && (
            <select
              className="form-select"
              style={{ width: 'auto', height: 34, fontSize: 12.5 }}
              value={child.id}
              disabled={childSwitching}
              onChange={e => switchChild(e.target.value)}
            >
              {children.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
          )}
          <button
            onClick={() => {
              // Always start from a clean slate, not whatever was left over from
              // a cancelled attempt (the Cancel buttons below don't reset the form).
              setLinkForm(EMPTY_LINK_FORM);
              setLinkErr('');
              setLinkStep(1);
              setLinkChildModal(true);
            }}
            className="qa-btn" style={{ width: 'auto', padding: '8px 14px', fontSize: 12.5 }}
          >
            <i className="fa-solid fa-plus" style={{ color: '#0EA5E9', marginRight: 5 }} />Link Another Child
          </button>
        </div>

        {/* Progress overview */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
          <div className="card" style={{ padding: '22px 24px' }}>
            <div className="section-title" style={{ marginBottom: 4 }}>{child.full_name}'s Record</div>
            <div className="section-sub" style={{ marginBottom: 16 }}>{child.client_code} · {child.therapy_type ? child.therapy_type + ' Program' : 'Awaiting assessment'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div style={{ gridColumn: '1/-1' }}><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Assigned Therapist</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{[
                child.assigned_ot_therapist_name && (child.therapy_type === 'Both' ? child.assigned_ot_therapist_name + ' (OT)' : child.assigned_ot_therapist_name),
                child.assigned_speech_therapist_name && (child.therapy_type === 'Both' ? child.assigned_speech_therapist_name + ' (Speech)' : child.assigned_speech_therapist_name),
              ].filter(Boolean).join(' · ') || 'Not yet assigned'}</div></div>
            </div>
            <div style={{ paddingTop: 12, borderTop: '1px solid #F1F5F9' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', marginBottom: 10 }}>Development &amp; Functional Information</div>
              {devFields.length === 0 ? (
                <div style={{ fontSize: 12, color: '#94A3B8' }}>Nothing recorded yet.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {devFields.map(f => (
                    <div key={f.id}>
                      <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>{f.label}</div>
                      <div style={{ fontSize: 12.5, color: '#0F172A' }}>{(child.dev_functional_data || {})[f.id] || '-'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ padding: '22px 24px' }}>
            <div className="section-title" style={{ marginBottom: 4 }}>Progress Trends</div>
            <div className="section-sub" style={{ marginBottom: 16 }}>GAS (Goal Attainment Scaling) trend from therapy sessions</div>
            {(child.gas_entries || []).length > 0 ? (
              <GasProgressChart entries={child.gas_entries} />
            ) : (
              <div style={{ textAlign: 'center', padding: '30px 0', color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-chart-line" style={{ fontSize: 24, marginBottom: 8, display: 'block' }} />No progress trend data recorded yet. This appears after your child's therapist logs GAS assessments.</div>
            )}
          </div>
        </div>

        <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · All rights reserved</span></div>
      </div>
    );
  }



  /* ═══════════════════════════════════════════════════════════
     BOOKING
     ═══════════════════════════════════════════════════════════ */
  function renderBooking() {
    const hasChildren = children && children.length > 0;
    const myReservations = (reservations || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const bookingChild = activeChild || (hasChildren ? children[0] : null);
    const sessionOptions = sessionTypesFor(bookingChild);
    // A Combined child may hold one OT and one Speech upcoming booking at once,
    // so the "already have an upcoming booking" gate only applies within the
    // currently selected session type's own discipline for them; any other
    // child (single discipline) keeps the original "any upcoming booking" gate.
    const selectedDiscipline = disciplineOfType(bookingSessionType);
    const childReservations = upcomingReservationsFor(bookingChild?.id);
    const activeBooking = (bookingChild?.therapy_type === 'Both' && selectedDiscipline)
      ? childReservations.find(r => disciplineOfType(r.session_type) === selectedDiscipline)
      : childReservations[0];
    const hasActiveBooking = !!activeBooking;

    return (
      <div className="spa-page" id="spa-booking">
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Book or Reschedule a Session</h1>
        </div>

        {!hasChildren ? (
          <div className="card" style={{ padding: '40px 20px' }}>
            <EmptyState icon="fa-calendar-xmark" title="Cannot Book Yet" description="You need a child profile linked to your account before you can book sessions. Please contact the clinic to set this up." />
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 24 }}>
              <div className="card" style={{ padding: '22px 24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                  <div><div className="section-title">New Reservation</div><div className="section-sub">Choose a date and an available time slot</div></div>
                  <span className="pill pill-blue">{selectedSlot ? selectedSlot + ' selected' : 'No time selected'}</span>
                </div>
                {children.length > 1 && (
                  <div style={{ marginBottom: 14 }}>
                    <label className="form-label">Booking For</label>
                    <select className="form-select" style={{ background: '#fff' }} value={bookingChild?.id || ''} disabled={childSwitching} onChange={e => switchBookingChild(e.target.value)}>
                      {children.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                    </select>
                  </div>
                )}
                {hasActiveBooking && activeBooking.status === 'awaiting_payment' && (
                  <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 9, padding: '12px 14px', marginBottom: 16, fontSize: 12.5, color: '#92400E', display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                    <i className="fa-solid fa-hourglass-half" style={{ marginTop: 1 }} />
                    <span style={{ flex: 1 }}>Your slot on {fmtDate(activeBooking.date)} · {activeBooking.time_slot} is held, status: Pending. Complete payment soon, unpaid holds are released automatically.</span>
                    <button className="btn-primary" style={{ fontSize: 11.5, padding: '6px 12px' }} onClick={() => {
                      const p = (payments || []).find(pm => pm.reservation_id === activeBooking.id);
                      if (p) generateQr(p);
                    }}>Complete Payment</button>
                  </div>
                )}
                {hasActiveBooking && activeBooking.status !== 'awaiting_payment' && (
                  <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 9, padding: '12px 14px', marginBottom: 16, fontSize: 12.5, color: '#92400E', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <i className="fa-solid fa-circle-info" style={{ marginTop: 1 }} />
                    <span>You already have an upcoming booking, {fmtDate(activeBooking.date)} · {activeBooking.time_slot} ({activeBooking.status}). Only one booking per child is allowed at a time. Cancel it under "My Booking Requests", or wait until its date has passed, before submitting a new one.</span>
                  </div>
                )}
                <div style={{ marginBottom: 14 }}>
                  <label className="form-label">Session Type</label>
                  {sessionOptions.length <= 1 ? (
                    <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#475569', background: '#F8FAFC', fontWeight: 600 }}>
                      {sessionOptions[0] || 'No eligible session type'}
                    </div>
                  ) : (
                    <select className="form-select" style={{ background: '#fff' }} value={bookingSessionType} onChange={e => setBookingSessionType(e.target.value)}>
                      {sessionOptions.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                  {!bookingChild?.assigned_ot_therapist_name && !bookingChild?.assigned_speech_therapist_name && !bookingChild?.therapy_type && (
                    <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 5 }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Only an Initial Assessment can be booked until the clinic assigns a therapy type and therapist.</div>
                  )}
                </div>
                <div style={{ marginBottom: 14, opacity: hasActiveBooking ? .55 : 1, pointerEvents: hasActiveBooking ? 'none' : 'auto' }}>
                  <label className="form-label">Requested Date &amp; Time</label>
                  <div className="booking-cal-grid">
                    <div>
                      <div className="cal-nav">
                        <button type="button" className="cal-nav-btn" disabled={calMonth <= ymFromDateStr(minBookableDateStr())} onClick={() => setCalMonth(m => addMonths(m, -1))}>
                          <i className="fa-solid fa-chevron-left" />
                        </button>
                        <div className="cal-month-label">{monthLabel(calMonth)}</div>
                        <button type="button" className="cal-nav-btn" onClick={() => setCalMonth(m => addMonths(m, 1))}>
                          <i className="fa-solid fa-chevron-right" />
                        </button>
                      </div>
                      <div className="cal-dow-row"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
                      <div className="cal-day-grid">
                        {Array.from({ length: firstWeekdayOfMonth(calMonth) }).map((_, i) => <div key={'pad' + i} className="cal-day is-outside" />)}
                        {Array.from({ length: daysInMonth(calMonth) }).map((_, i) => {
                          const day = i + 1;
                          const dateStr = calMonth + '-' + String(day).padStart(2, '0');
                          const disabled = dateStr < minBookableDateStr() || hasActiveBooking;
                          const isSelected = dateStr === reservationDate;
                          const isToday = dateStr === todayStr();
                          const cls = 'cal-day' + (isSelected ? ' is-selected' : '') + (isToday && !isSelected ? ' is-today' : '');
                          return (
                            <button key={dateStr} type="button" className={cls} disabled={disabled} onClick={disabled ? undefined : () => changeDate(dateStr)}>
                              {day}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="slots-col">
                      <div className="slots-col-header" style={slotError ? { color: '#DC2626' } : undefined}>
                        {reservationDate ? new Date(reservationDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'Select a date'}
                        {slotError && <span style={{ fontWeight: 400, fontSize: 11.5 }}> &ndash; please pick a time</span>}
                      </div>
                      <div
                        className="slot-list"
                        style={{
                          // Column-major fill (top-to-bottom then next column), so row
                          // count must match the actual slot count, not a fixed guess.
                          gridTemplateRows: 'repeat(' + Math.max(1, Math.ceil(slotsForDate.length / 2)) + ', auto)',
                          ...(slotError ? { border: '1px solid #FCA5A5', borderRadius: 10, padding: 8, background: '#FEF2F2' } : null)
                        }}
                      >
                        {slotsForDate.length === 0 && (() => {
                          const holiday = holidays.find(h => h.date === reservationDate);
                          return (
                            <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '6px 2px' }}>
                              {holiday
                                ? <>The clinic is closed on this date{holiday.label ? ' (' + holiday.label + ')' : ''}, please pick another day.</>
                                : 'No time slots for this date, no therapists are on shift.'}
                            </div>
                          );
                        })()}
                        {slotsForDate.map(s => {
                          const t = s.time_slot;
                          // Initial Assessment has no dedicated therapist picked ahead of time,
                          // so it's capped at one booking per hour clinic-wide, same rule as
                          // the admin booking calendar (reservationsHelpers.effectiveSlotAvailable),
                          // instead of the raw multi-therapist capacity every other type uses.
                          const effAvailable = effectiveSlotAvailable(s, bookingSessionType);
                          const full = effAvailable <= 0;
                          const past = isSlotPast(reservationDate, t);
                          const blocked = full || past || hasActiveBooking;
                          const isSelected = t === selectedSlot;
                          const cls = 'slot-btn' + (blocked ? '' : (isSelected ? ' active' : ''));
                          const style = blocked ? { opacity: .45, cursor: 'not-allowed', background: '#F1F5F9', borderColor: '#E2E8F0', color: '#94A3B8' } : undefined;
                          return (
                            <button key={t} className={cls} style={style} disabled={blocked} onClick={blocked ? undefined : () => pickSlot(t)}>
                              {t}
                              {s.lunch_break && <span style={{ fontSize: 10, fontWeight: 400 }}> (Lunch Break)</span>}
                              {!s.lunch_break && full && <span style={{ fontSize: 10, fontWeight: 400 }}> (Full)</span>}
                              {!s.lunch_break && !full && past && <span style={{ fontSize: 10, fontWeight: 400 }}> (Past)</span>}
                              {!s.lunch_break && !full && !past && bookingSessionType !== 'Initial Assessment' && s.capacity > 1 && <span style={{ fontSize: 10, fontWeight: 400 }}> · {s.available} left</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn-primary" disabled={bookingBusy || hasActiveBooking} onClick={openBookingConfirm}>Book</button>
                </div>
              </div>
            </div>

            {/* Booking details, shown once the active booking is actually reserved (paid/confirmed), not while still awaiting payment */}
            {hasActiveBooking && ['confirmed', 'rescheduled'].includes(activeBooking.status) && (() => {
              const bookedPayment = (payments || []).find(p => p.reservation_id === activeBooking.id);
              return (
                <div className="card" style={{ padding: '22px 24px', marginBottom: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                    <div><div className="section-title">Booking Details</div><div className="section-sub">Your reserved session</div></div>
                    <span className="pill pill-green"><i className="fa-solid fa-circle-check" style={{ marginRight: 5 }} />Reserved</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <div>
                      <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Child</div>
                      <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{bookingChild?.full_name || '-'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Session Type</div>
                      <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{activeBooking.session_type}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Date &amp; Time</div>
                      <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{fmtDate(activeBooking.date)} · {activeBooking.time_slot}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Therapist</div>
                      <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{activeBooking.therapist_name || 'Not yet assigned'}</div>
                    </div>
                    {activeBooking.room && (
                      <div>
                        <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Room</div>
                        <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{activeBooking.room}</div>
                      </div>
                    )}
                    {bookedPayment && (
                      <>
                        <div>
                          <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Invoice No.</div>
                          <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{bookedPayment.invoice_no || '-'}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Amount Paid</div>
                          <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>₱{Number(bookedPayment.amount).toLocaleString()}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Payment Method</div>
                          <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{bookedPayment.method || '-'}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Paid On</div>
                          <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{bookedPayment.paid_at ? fmtDate(bookedPayment.paid_at.slice(0, 10)) : '-'}</div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Booking history */}
            <div className="card" style={{ padding: '22px 24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <div><div className="section-title">My Booking Requests</div><div className="section-sub">Live status updates from the clinic</div></div>
              </div>
              <div className="history-list">
                {myReservations.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: '#94A3B8', textAlign: 'center', padding: '20px 0' }}><i className="fa-solid fa-inbox" style={{ marginRight: 7 }} />No booking requests yet. Submit one above!</div>
                ) : myReservations.slice(0, 10).map(r => {
                  const badge = r.status === 'confirmed' ? <span className="pill pill-green">Confirmed</span>
                    : r.status === 'awaiting_payment' ? <span className="pill pill-amber">Pending</span>
                    : r.status === 'declined' ? <span className="pill pill-red">Declined</span>
                    : r.status === 'cancelled' ? <span className="pill pill-gray">Cancelled</span>
                    : r.status === 'rescheduled' ? <span className="pill pill-blue">Rescheduled</span>
                    : <span className="pill pill-amber">Pending Review</span>;
                  return (
                    <div className="history-item" key={r.id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{fmtDate(r.date)} · {r.time_slot}</div>{badge}
                      </div>
                      <div style={{ fontSize: 12.5, color: '#64748B' }}>{r.session_type}{r.clients?.full_name ? ' · ' + r.clients.full_name : ''}</div>
                      {r.status === 'declined' && r.notes && (
                        <div style={{ marginTop: 6, padding: '7px 10px', borderRadius: 7, background: '#FEF2F2', border: '1px solid #FECACA', fontSize: 12, color: '#DC2626' }}>
                          <i className="fa-solid fa-comment-slash" style={{ marginRight: 5 }} />{r.notes}
                        </div>
                      )}
                      {r.status === 'awaiting_payment' && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                          <button className="btn-primary" style={{ fontSize: 11, padding: '5px 10px' }} onClick={() => {
                            const p = (payments || []).find(pm => pm.reservation_id === r.id);
                            if (p) generateQr(p);
                          }}>Complete Payment</button>
                          <button className="btn-secondary" style={{ fontSize: 11, padding: '5px 10px' }} onClick={() => setCancelTarget(r)}><i className="fa-solid fa-xmark" style={{ marginRight: 4 }} />Cancel Booking</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · All rights reserved</span></div>
      </div>
    );
  }



  /* ═══════════════════════════════════════════════════════════
     PAYMENTS
     ═══════════════════════════════════════════════════════════ */
  function renderPayment() {
    const hasChildren = children && children.length > 0;

    if (!hasChildren) {
      return (
        <div className="spa-page" id="spa-payment">
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Payments</h1>
            <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Manage session payments and download invoices.</p>
          </div>
          <div className="card" style={{ padding: '40px 20px' }}>
            <EmptyState icon="fa-credit-card" title="No Payment Records" description="Once your child's profile is linked, you'll see outstanding balances and payment history here." />
          </div>
        </div>
      );
    }

    return (
      <div className="spa-page" id="spa-payment">
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Secure Payment Checkout</h1>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 22, flexWrap: 'wrap' }}>
          <button className={'pay-tab' + (payTab === 'checkout' ? ' active' : '')} onClick={() => setPayTab('checkout')}><i className="fa-solid fa-credit-card" style={{ marginRight: 6 }} />Pay Now</button>
          <button className={'pay-tab' + (payTab === 'receipts' ? ' active' : '')} onClick={() => setPayTab('receipts')}><i className="fa-solid fa-file-invoice" style={{ marginRight: 6 }} />Invoice</button>
        </div>

        {/* Checkout tab, real, self-serve QRPh via PayMongo, one invoice at a time */}
        <div style={{ display: payTab === 'checkout' ? 'block' : 'none' }}>
          {pendingPayments.length === 0 ? (
            <div className="card" style={{ padding: '40px 20px' }}>
              <EmptyState icon="fa-circle-check" title="All Paid Up!" description="You have no outstanding balances. Great job keeping your payments current!" />
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }}>
              <div className="card" style={{ padding: '22px 0 0' }}>
                <div style={{ padding: '0 20px 14px', borderBottom: '1px solid #F1F5F9' }}>
                  <div className="section-title"><i className="fa-solid fa-qrcode" style={{ color: '#0EA5E9', marginRight: 7 }} />Pay Pending Balance</div>
                  <div className="section-sub">Pay any session instantly with a real QRPh code, scan with GCash, Maya, or any bank app</div>
                </div>
                <div>
                  {pendingPayments.map(p => {
                    // Cancelling only makes sense while the slot is still an unpaid
                    // hold, once confirmed (e.g. staff booked it in person and picked
                    // QRPh for a later payment), this is just an outstanding invoice,
                    // not a hold to release, so no Cancel option for that case.
                    const linkedRes = (reservations || []).find(r => r.id === p.reservation_id);
                    const cancellable = linkedRes?.status === 'awaiting_payment';
                    return (
                      <div className="balance-row" key={p.id}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{p.invoice_no || 'Session'}</div>
                          <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{fmtDate((p.created_at || '').slice(0, 10))} · <span className="pill pill-amber" style={{ fontSize: 9 }}>{p.status}</span></div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>₱{Number(p.amount).toLocaleString()}</span>
                          {cancellable && (
                            <button className="btn-secondary" style={{ fontSize: 12, padding: '8px 14px' }} onClick={() => setCancelTarget(linkedRes)}>
                              <i className="fa-solid fa-xmark" style={{ marginRight: 5 }} />Cancel
                            </button>
                          )}
                          <button className="btn-primary" style={{ fontSize: 12, padding: '8px 14px' }} disabled={qrBusy} onClick={() => generateQr(p)}>
                            <i className="fa-solid fa-qrcode" style={{ marginRight: 5 }} />Pay with QRPh
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ padding: '12px 20px', borderTop: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#16A34A' }}>
                  <i className="fa-solid fa-lock" /> Payments are processed securely by PayMongo, KID Clinic never sees your bank or wallet details.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Invoice tab */}
        <div style={{ display: payTab === 'receipts' ? 'block' : 'none' }}>
          {paidPayments.length === 0 && refundedPayments.length === 0 ? (
            <div className="card" style={{ padding: '40px 20px' }}>
              <EmptyState icon="fa-file-invoice" title="No Invoices Yet" description="Invoices will appear here once you've made payments for therapy sessions." />
            </div>
          ) : (
            <div className="card" style={{ padding: '22px 0 0' }}>
              <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9' }}>
                <div className="section-title">Digital Billing Invoices</div>
                <div className="section-sub">Payment records with reference keys</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th style={{ paddingLeft: 24 }}>Invoice</th><th>Date</th><th>Amount</th><th>Method</th><th>Reference</th><th>Status</th><th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th></tr></thead>
                  <tbody>
                    {paidPayments.map(p => (
                      <tr key={p.id}>
                        <td style={{ paddingLeft: 24 }}><div style={{ fontSize: 12, fontWeight: 600, color: '#0F172A' }}>{p.invoice_no || '-'}</div></td>
                        <td style={{ fontSize: 12.5 }}>{p.paid_at ? fmtDate(p.paid_at.slice(0, 10)) : '-'}</td>
                        <td style={{ fontWeight: 700, color: '#10B981' }}>₱{Number(p.amount).toLocaleString()}</td>
                        <td><span className="pill pill-green" style={{ fontSize: 10 }}>{p.method}</span></td>
                        <td>{p.reference ? <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#0284C7', background: '#EFF6FF', padding: '2px 8px', borderRadius: 5, display: 'inline-block' }}>{p.reference}</div> : '-'}</td>
                        <td><span className="pill pill-green" style={{ fontSize: 10 }}>Paid</span></td>
                        <td style={{ textAlign: 'right', paddingRight: 24 }}><button className="btn-edit" style={{ fontSize: 11 }} onClick={() => setInvoice(p)}><i className="fa-solid fa-file-invoice" /> View</button></td>
                      </tr>
                    ))}
                    {refundedPayments.map(p => (
                      <tr key={p.id}>
                        <td style={{ paddingLeft: 24 }}><div style={{ fontSize: 12, fontWeight: 600, color: '#0F172A' }}>{p.invoice_no || '-'}</div></td>
                        <td style={{ fontSize: 12.5 }}>{p.paid_at ? fmtDate(p.paid_at.slice(0, 10)) : '-'}</td>
                        <td style={{ fontWeight: 700, color: '#B45309' }}>₱{Number(p.amount).toLocaleString()}</td>
                        <td><span className="pill pill-gray" style={{ fontSize: 10 }}>{p.method}</span></td>
                        <td>{p.reference ? <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#0284C7', background: '#EFF6FF', padding: '2px 8px', borderRadius: 5, display: 'inline-block' }}>{p.reference}</div> : '-'}</td>
                        <td>
                          <span className="pill pill-red" style={{ fontSize: 10 }}>Refunded</span>
                          {p.refund_reason && <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 3 }}>{p.refund_reason}</div>}
                        </td>
                        <td style={{ textAlign: 'right', paddingRight: 24 }}><button className="btn-edit" style={{ fontSize: 11 }} onClick={() => setInvoice(p)}><i className="fa-solid fa-file-invoice" /> View</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Guardian/Caretaker Portal</span></div>
      </div>
    );
  }



  /* ═══════════════════════════════════════════════════════════
     NOTIFICATIONS
     ═══════════════════════════════════════════════════════════ */
  function renderNotifications() {
    const allNotifs = notifications || [];

    return (
      <div className="spa-page" id="spa-notifications">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Notifications</h1>
          </div>
        </div>

        {/* Notification list */}
        {allNotifs.length === 0 ? (
          <div className="card" style={{ padding: '40px 20px' }}>
            <EmptyState icon="fa-bell-slash" title="No Notifications" description="You don't have any notifications yet. You'll receive updates about sessions, payments, and schedule changes here." />
          </div>
        ) : (
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><div className="section-title">All Notifications</div></div>
            </div>
            <div style={{ padding: '8px 24px 0' }}>
              {allNotifs.map(n => (
                <div key={n.id} className={'notif-row' + (!n.read ? ' unread' : '')} style={{ borderBottom: '1px solid #F8FAFC' }}>
                  <div className="notif-icon" style={{ background: !n.read ? '#DBEAFE' : '#F1F5F9', color: !n.read ? '#2563EB' : '#94A3B8' }}><i className={'fa-solid ' + (n.icon || 'fa-bell')} /></div>
                  {!n.read && <div className="unread-dot" />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: !n.read ? 600 : 500, color: '#0F172A', fontSize: 13.5 }}>{n.title}</div>
                    {n.body && <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{n.body}</div>}
                    <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{n.created_at ? new Date(n.created_at).toLocaleString() : ''}</div>
                  </div>
                  {!n.read && <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => markNotifRead(n.id)}>Mark read</button>}
                </div>
              ))}
            </div>
            <div style={{ padding: '14px 24px', borderTop: '1px solid #F1F5F9' }}>
              <span style={{ fontSize: 12, color: '#64748B' }}>Showing {allNotifs.length} notification{allNotifs.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        )}

        <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · Guardian/Caretaker Portal</span></div>
      </div>
    );
  }

  /* ═══════════════════════════════════════════════════════════
     MAIN RETURN, sidebar + header + content
     ═══════════════════════════════════════════════════════════ */
  return (
    <>
      <aside id="sidebar" className={sidebarOpen ? 'open' : ''}>
        <BrandLogo subtitle="Guardian/Caretaker Portal" />
        <nav>
          <div className="nav-label">Overview</div>
          <a className={'nav-item' + (page === 'dashboard' ? ' active' : '')} onClick={() => goPage('dashboard')}><span className="icon"><i className="fa-solid fa-chart-pie" /></span> Dashboard</a>
          <div className="nav-label">Services</div>
          <a className={'nav-item' + (page === 'booking' ? ' active' : '')} onClick={() => goPage('booking')}><span className="icon"><i className="fa-solid fa-calendar-check" /></span> Book Session</a>
          <a className={'nav-item' + (page === 'payment' ? ' active' : '')} onClick={() => goPage('payment')}><span className="icon"><i className="fa-solid fa-credit-card" /></span> Payments</a>
          <div className="nav-label">System</div>
          <a className={'nav-item' + (page === 'notifications' ? ' active' : '')} onClick={() => goPage('notifications')}><span className="icon"><i className="fa-solid fa-bell" /></span> Notifications {unreadCount > 0 && <span className="nav-badge">{unreadCount}</span>}</a>
        </nav>
      </aside>
      <div id="sidebar-backdrop" className={sidebarOpen ? 'open' : ''} onClick={() => setSidebarOpen(false)} />

      <div id="main">
        <header id="topnav">
          <button id="hamburger" className="topnav-btn" onClick={() => setSidebarOpen(s => !s)}><i className="fa-solid fa-bars" /></button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
            <div style={{ position: 'relative' }}>
              <button className="topnav-btn" id="notif-btn" onClick={toggleNotif}><i className="fa-regular fa-bell" />{unreadCount > 0 && <span className="notif-dot" />}</button>
              <div id="notif-panel" className={notifOpen ? 'open' : ''}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #F1F5F9' }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>Notifications</span>
                  {unreadCount > 0 && <span style={{ background: '#EF4444', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, marginLeft: 6 }}>{unreadCount}</span>}
                </div>
                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {(notifications || []).slice(0, 5).map((n, i) => (
                    <div key={n.id || i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', cursor: n.read ? 'default' : 'pointer', background: !n.read ? '#F0F9FF' : '#fff', borderBottom: '1px solid #F8FAFC' }} onClick={() => !n.read && markNotifRead(n.id)}>
                      <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: '#E0F2FE', color: '#0EA5E9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <i className={'fa-solid ' + (n.icon || 'fa-bell')} style={{ fontSize: 13 }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: '#0F172A', fontWeight: !n.read ? 600 : 500, lineHeight: 1.3 }}>{n.title}</div>
                        <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.body}</div>
                      </div>
                      {!n.read && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#0EA5E9', flexShrink: 0, marginTop: 4 }} />}
                    </div>
                  ))}
                  {(!notifications || notifications.length === 0) && (
                    <div style={{ padding: 20, textAlign: 'center', fontSize: 12.5, color: '#94A3B8' }}>No notifications yet</div>
                  )}
                </div>
                <div style={{ padding: '12px 16px', borderTop: '1px solid #F1F5F9', textAlign: 'center' }}>
                  <a href="#" onClick={e => { e.preventDefault(); setNotifOpen(false); goPage('notifications'); }} style={{ fontSize: 12, color: '#0EA5E9', cursor: 'pointer', fontWeight: 500, textDecoration: 'none' }}>View all notifications →</a>
                </div>
              </div>
            </div>
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 6px', borderRadius: 10 }} id="profile-btn" onClick={toggleProfile}>
                <div className="avatar">{initials(user?.name)}</div>
                <div style={{ lineHeight: 1.2 }}><span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'Poppins',sans-serif" }}>{user?.name || 'User'}</span><br /><span style={{ fontSize: 11, color: '#64748B' }}>Guardian/Caretaker</span></div>
                <i className="fa-solid fa-chevron-down" style={{ fontSize: 10, color: '#94A3B8', marginLeft: 2 }} />
              </div>
              <div id="profile-panel" className={profileOpen ? 'open' : ''}>
                <a className="pp-item" href="#" onClick={e => { e.preventDefault(); openProfileModal(); }} style={{ textDecoration: 'none' }}><i className="fa-regular fa-user" style={{ color: '#64748B', width: 14 }} /> My Profile</a>
                <a className="pp-item" href="#" onClick={e => { e.preventDefault(); setProfileOpen(false); doLogout(); }} style={{ color: '#EF4444', textDecoration: 'none' }}><i className="fa-solid fa-arrow-right-from-bracket" style={{ width: 14 }} /> Logout</a>
              </div>
            </div>
          </div>
        </header>

        <div id="content">
          {loading && <div style={{ padding: 60, textAlign: 'center', color: '#94A3B8' }}><i className="fa-solid fa-spinner fa-spin" style={{ fontSize: 24 }} /><div style={{ marginTop: 12, fontSize: 13 }}>Loading your portal...</div></div>}
          {!loading && page === 'dashboard' && renderDashboard()}
          {!loading && page === 'booking' && renderBooking()}
          {!loading && page === 'payment' && renderPayment()}
          {!loading && page === 'notifications' && renderNotifications()}
        </div>
      </div>

      {qrModal && (
        <Modal onClose={() => setQrModal(null)} title={qrModal.payment.invoice_no || 'QRPh Payment'}>
          <div style={{ textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>₱{Number(qrModal.payment.amount).toLocaleString()}</div>
            {qrModal.status === 'paid' ? (
              <>
                <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#DCFCE7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}><i className="fa-solid fa-check" style={{ fontSize: 28, color: '#16A34A' }} /></div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', marginBottom: 16 }}>Payment Confirmed</div>
                <button className="btn-primary" style={{ width: '100%' }} onClick={() => { const p = qrModal.payment; setQrModal(null); setInvoice(p); }}>
                  <i className="fa-solid fa-file-invoice" style={{ marginRight: 6 }} />View Invoice
                </button>
              </>
            ) : qrModal.image ? (
              <>
                <img src={qrModal.image} alt="QRPh code" style={{ width: 240, height: 240, borderRadius: 10, border: '1px solid #E2E8F0' }} />
                <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 10 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Waiting for payment, scan with GCash, Maya, or your bank app</div>
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
        </Modal>
      )}

      {idleWarning && (
        <Modal onClose={stayLoggedIn} title="Still there?" width={400}>
          <div style={{ textAlign: 'center', padding: '6px 0 4px' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#FFFBEB', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <i className="fa-solid fa-clock" style={{ fontSize: 22, color: '#B45309' }} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>You've been idle for a while</div>
            <div style={{ fontSize: 12.5, color: '#64748B', marginBottom: 18 }}>
              For your security, you'll be logged out in <b style={{ color: '#B45309' }}>{idleCountdown}s</b> unless you stay logged in.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn-secondary" style={{ flex: 1, padding: 10 }} onClick={doLogout}>Log Out</button>
              <button className="btn-primary" style={{ flex: 1, padding: 10 }} onClick={stayLoggedIn}>Continue Session</button>
            </div>
          </div>
        </Modal>
      )}

      {cancelTarget && (
        <Modal onClose={() => !cancelBusy && setCancelTarget(null)} title="Cancel Booking" width={420}>
          <div style={{ textAlign: 'center', padding: '6px 0 4px' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#FEF2F2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <i className="fa-solid fa-calendar-xmark" style={{ fontSize: 22, color: '#DC2626' }} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>Cancel this booking?</div>
            <div style={{ fontSize: 12.5, color: '#64748B', marginBottom: 4 }}>{fmtDate(cancelTarget.date)} · {cancelTarget.time_slot}</div>
            <div style={{ fontSize: 12.5, color: '#64748B', marginBottom: 18 }}>{cancelTarget.session_type}{cancelTarget.clients?.full_name ? ' · ' + cancelTarget.clients.full_name : ''}</div>
            <div style={{ fontSize: 11.5, color: '#94A3B8', marginBottom: 18 }}>This releases the held slot since it hasn't been paid yet. You can submit a new booking any time.</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn-secondary" style={{ flex: 1, padding: 10 }} disabled={cancelBusy} onClick={() => setCancelTarget(null)}>Keep Booking</button>
              <button style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: '#DC2626', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: cancelBusy ? .7 : 1 }} disabled={cancelBusy} onClick={confirmCancelReservation}>
                {cancelBusy ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Cancelling…</> : 'Yes, Cancel'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {bookingConfirm && (() => {
        const confirmChild = activeChild || (children && children.length ? children[0] : null);
        return (
          <Modal onClose={() => !bookingBusy && setBookingConfirm(false)} title="Confirm Booking" width={420}>
            <div style={{ textAlign: 'center', padding: '6px 0 4px' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                <i className="fa-solid fa-calendar-check" style={{ fontSize: 22, color: '#0EA5E9' }} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 14 }}>Please confirm the details below</div>
              <div style={{ textAlign: 'left', background: '#F8FAFC', border: '1px solid #F1F5F9', borderRadius: 10, padding: '12px 14px', marginBottom: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Child</div>
                  <div style={{ fontSize: 12.5, color: '#0F172A', fontWeight: 600 }}>{confirmChild?.full_name || '-'}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Session Type</div>
                  <div style={{ fontSize: 12.5, color: '#0F172A', fontWeight: 600 }}>{bookingSessionType || '-'}</div>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Date &amp; Time</div>
                  <div style={{ fontSize: 12.5, color: '#0F172A', fontWeight: 600 }}>{fmtDate(reservationDate)} · {selectedSlot}</div>
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: '#94A3B8', marginBottom: 18 }}>Submitting holds this slot for you. Complete payment afterward to confirm it, unpaid holds are released automatically.</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn-secondary" style={{ flex: 1, padding: 10 }} disabled={bookingBusy} onClick={() => setBookingConfirm(false)}>Go Back</button>
                <button className="btn-primary" style={{ flex: 1, padding: 10 }} disabled={bookingBusy} onClick={confirmSubmitReservation}>
                  {bookingBusy ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Submitting…</> : 'Confirm Booking'}
                </button>
              </div>
            </div>
          </Modal>
        );
      })()}

      {/* Printable invoice/receipt */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #invoice-print, #invoice-print * { visibility: visible; }
          #invoice-print { position: fixed; top: 0; left: 0; width: 100%; margin: 0; box-shadow: none; border: none; }
        }
      `}</style>
      {invoice && (
        <Modal onClose={() => setInvoice(null)} title="Invoice" width={520}>
          <div id="invoice-print" style={{ background: '#fff', fontFamily: "'Inter',Arial,sans-serif" }}>
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
                  <span className={'pill ' + (invoice.status === 'refunded' ? 'pill-red' : 'pill-green')} style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>{invoice.status}</span>
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
                {invoice.clients?.client_code && <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>{invoice.clients.client_code}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 0' }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Invoice Date</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{fmtDate((invoice.paid_at || invoice.created_at || '').slice(0, 10))}</div>
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
                      {invoice.reservations?.date ? fmtDate(invoice.reservations.date) : fmtDate((invoice.paid_at || invoice.created_at || '').slice(0, 10))}
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
                  <span style={{ fontWeight: 700, color: '#0F172A' }}>Total {invoice.status === 'refunded' ? 'Refunded' : 'Paid'}</span>
                  <span style={{ fontFamily: "'Poppins',sans-serif", fontSize: 17, fontWeight: 700, color: invoice.status === 'refunded' ? '#B45309' : '#10B981' }}>₱{Number(invoice.amount).toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* Payment details */}
            <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid #E2E8F0' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Payment Details</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
                <div><span style={{ color: '#64748B' }}>Method: </span><span style={{ fontWeight: 600 }}>{invoice.method}</span></div>
                <div><span style={{ color: '#64748B' }}>Reference: </span><span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#0284C7' }}>{invoice.reference || '-'}</span></div>
                {invoice.status === 'refunded' && invoice.refund_reason && (
                  <div style={{ gridColumn: '1/-1' }}><span style={{ color: '#64748B' }}>Refund Reason: </span><span style={{ fontWeight: 600 }}>{invoice.refund_reason}</span></div>
                )}
              </div>
            </div>

            {/* Footer note */}
            <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid #E2E8F0', textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: '#475569', fontWeight: 600 }}>Thank you for trusting {brand?.clinic_name || 'Bloomsdale Therapy Center'} with your child's care.</div>
              <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>This is a system-generated invoice and does not require a signature.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button className="btn-primary" style={{ flex: 1, padding: 10 }} onClick={printInvoice}><i className="fa-solid fa-print" style={{ marginRight: 5 }} />Print / Save as PDF</button>
            <button className="btn-secondary" style={{ flex: 1, padding: 10 }} onClick={() => setInvoice(null)}>Close</button>
          </div>
        </Modal>
      )}

      {profileModal && (
        <Modal onClose={() => setProfileModal(false)} title="My Profile">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label className="form-label">Name</label>
              <input className="form-input" value={user?.name || ''} disabled style={{ background: '#F1F5F9' }} />
            </div>
            <div>
              <label className="form-label">Email</label>
              <input className="form-input" value={user?.email || ''} disabled style={{ background: '#F1F5F9' }} />
            </div>
            <div>
              <label className="form-label">Phone Number *</label>
              <input className="form-input" type="tel" value={formatPhoneDisplay(contactInput)} onChange={handleContactInput} placeholder="+63 000 000 0000" maxLength={16} />
              {contactErr && <div style={{ fontSize: 11.5, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{contactErr}</div>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn-secondary" onClick={() => setProfileModal(false)} disabled={contactSaving}>Cancel</button>
              <button className="btn-primary" onClick={saveContact} disabled={contactSaving}>
                {contactSaving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {linkChildModal && (
        <Modal
          onClose={() => { setLinkChildModal(false); setLinkErr(''); setLinkConsent(false); setConsentChecked(false); setLinkStep(1); }}
          title={!(linkConsent || user?.privacy_consent_at) ? 'Data Privacy Consent' : onboarding ? 'Welcome to KID Clinic!' : 'Link Your Child'}
        >
          {!(linkConsent || user?.privacy_consent_at) ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 46, height: 46, borderRadius: '50%', background: '#EFF6FF', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <i className="fa-solid fa-shield-halved" style={{ color: '#1F4E9E', fontSize: 20 }} />
              </div>
              <div style={{ fontSize: 13.5, color: '#334155', lineHeight: 1.6 }}>
                Before you register your child, please read how we handle your family's information.
              </div>
            </div>
            <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 10, padding: '16px 18px', fontSize: 13, color: '#475569', lineHeight: 1.8, marginBottom: 16 }}>
              <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>Data Privacy Notice (Republic Act 10173, Data Privacy Act of 2012)</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li><strong>What we collect:</strong> your child's name, birthdate, gender, allergies and medications, and your contact details as parent/guardian.</li>
                <li><strong>Why we collect it:</strong> solely to provide pediatric therapy services, scheduling sessions, tracking progress, and contacting you about your child's care.</li>
                <li><strong>Who can see it:</strong> only authorized KID Clinic staff and your child's therapists. We never sell or share your information with third parties.</li>
                <li><strong>Your rights:</strong> you may request to view, correct, or delete your child's records at any time by contacting the clinic.</li>
              </ul>
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, color: '#334155', cursor: 'pointer', marginBottom: 18, lineHeight: 1.6 }}>
              <input type="checkbox" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)} style={{ marginTop: 3, width: 16, height: 16, accentColor: '#1F4E9E', cursor: 'pointer' }} />
              <span>I have read and understood this notice, and as the child's parent/guardian I <strong>consent</strong> to KID Clinic collecting and processing this information to provide therapy services.</span>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button type="button" onClick={() => { setLinkChildModal(false); setLinkConsent(false); setConsentChecked(false); }} style={{ padding: '10px 20px', background: '#F1F5F9', color: '#475569', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button type="button" disabled={!consentChecked} onClick={agreeConsent} style={{ padding: '10px 24px', background: consentChecked ? '#1F4E9E' : '#CBD5E1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: consentChecked ? 'pointer' : 'default' }}>
                I Agree, Continue
              </button>
            </div>
          </div>
          ) : (
          <div
            onKeyDown={e => {
              // Plain <div>, not <form>, on purpose: a native <form> can be
              // submitted by the browser itself (Enter in a field, autofill,
              // extensions, ...), which was reaching "Register Child" without
              // ever going through the Next button's step-by-step validation.
              // Enter is handled by hand instead: advance a step, or submit
              // for real only once actually on the last one.
              if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (linkStep < 3) nextLinkStep(); else submitLinkChild();
              }
            }}
          >
            {onboarding && (
              <div style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 8, padding: '12px 16px', fontSize: 13.5, color: '#1E40AF', marginBottom: 16, lineHeight: 1.6 }}>
                <i className="fa-solid fa-hand-sparkles" style={{ marginRight: 8 }} />
                Let's set up your child's profile first, booking sessions and tracking progress all start here. It only takes a minute.
              </div>
            )}

            {/* Step indicator, three connected sections presented one at a time. */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 22 }}>
              {[{ n: 1, label: 'Child' }, { n: 2, label: 'Guardian' }, { n: 3, label: 'Development' }].map((s, i, arr) => (
                <div key={s.n} style={{ display: 'flex', alignItems: 'center', flex: i < arr.length - 1 ? 1 : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 700, flexShrink: 0,
                      background: linkStep === s.n ? '#1F4E9E' : linkStep > s.n ? '#0D9488' : '#E2E8F0',
                      color: linkStep >= s.n ? '#fff' : '#94A3B8'
                    }}>
                      {linkStep > s.n ? <i className="fa-solid fa-check" style={{ fontSize: 10 }} /> : s.n}
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: linkStep === s.n ? '#0F172A' : '#94A3B8', whiteSpace: 'nowrap' }}>{s.label}</span>
                  </div>
                  {i < arr.length - 1 && <div style={{ flex: 1, height: 2, background: linkStep > s.n ? '#0D9488' : '#E2E8F0', margin: '0 10px' }} />}
                </div>
              ))}
            </div>

            {linkErr && (
              <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#C4302B', marginBottom: 16, fontWeight: 600 }}>
                <i className="fa-solid fa-circle-exclamation" style={{ marginRight: 6 }} />{linkErr}
              </div>
            )}

            {linkStep === 1 && (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #E2E8F0' }}>
                  <i className="fa-solid fa-child" style={{ marginRight: 8, color: '#0EA5E9' }} />Child's Information
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label className="form-label">Last Name *</label>
                    <input className="form-input" value={linkForm.last_name} onChange={handleNameInput('last_name')} placeholder="Child's last name" required />
                    {nameNotes.last_name && <div style={{ fontSize: 11.5, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{nameNotes.last_name}</div>}
                  </div>
                  <div>
                    <label className="form-label">First Name *</label>
                    <input className="form-input" value={linkForm.first_name} onChange={handleNameInput('first_name')} placeholder="Child's first name" required />
                    {nameNotes.first_name && <div style={{ fontSize: 11.5, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{nameNotes.first_name}</div>}
                  </div>
                  <div>
                    <label className="form-label">Middle Name <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
                    <input className="form-input" value={linkForm.middle_name} onChange={handleNameInput('middle_name')} placeholder="Child's middle name" />
                    {nameNotes.middle_name && <div style={{ fontSize: 11.5, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{nameNotes.middle_name}</div>}
                  </div>
                  <div>
                    <label className="form-label">Date of Birth *</label>
                    <input className="form-input" type="date" value={linkForm.dob} min={minPatientDob()} max={maxPatientDob()} onChange={e => setLinkForm(f => ({ ...f, dob: e.target.value }))} required />
                    <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 4 }}>Patient must be 3–21 years old</div>
                  </div>
                  <div>
                    <label className="form-label">Gender *</label>
                    <select className="form-select" value={linkForm.gender} onChange={e => setLinkForm(f => ({ ...f, gender: e.target.value }))} required>
                      <option value="">Select...</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                    </select>
                  </div>
                  <div>
                    <label className="form-label">Allergies <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
                    <input className="form-input" value={linkForm.allergies} onChange={handleTextInput('allergies')} placeholder="Food, medicine, etc." />
                    {textNotes.allergies && <div style={{ fontSize: 11.5, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{textNotes.allergies}</div>}
                  </div>
                  <div>
                    <label className="form-label">Daily Medication <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
                    <input className="form-input" value={linkForm.daily_medication} onChange={handleTextInput('daily_medication')} placeholder="Only if relevant to therapy sessions" />
                    {textNotes.daily_medication && <div style={{ fontSize: 11.5, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{textNotes.daily_medication}</div>}
                  </div>
                </div>
              </>
            )}

            {linkStep === 2 && (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #E2E8F0' }}>
                  <i className="fa-solid fa-user-shield" style={{ marginRight: 8, color: '#0D9488' }} />Guardian/Caretaker Information
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label className="form-label">Relationship to Child *</label>
                    <select className="form-select" value={linkForm.guardian_relationship} onChange={e => setLinkForm(f => ({ ...f, guardian_relationship: e.target.value }))} required>
                      <option value="Parent">Parent</option>
                      <option value="Guardian">Guardian</option>
                      <option value="Caretaker">Caretaker</option>
                    </select>
                  </div>
                  <div>
                    <label className="form-label">Date of Birth *</label>
                    <input className="form-input" type="date" value={linkForm.guardian_dob} min={minGuardianDob()} max={maxGuardianDob()} onChange={e => setLinkForm(f => ({ ...f, guardian_dob: e.target.value }))} required />
                    <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 4 }}>Must be 18 years old or above</div>
                  </div>
                  <div>
                    <label className="form-label">Phone Number</label>
                    <input className="form-input" type="tel" value={formatPhoneDisplay(user?.contact || '')} disabled style={{ background: '#F1F5F9' }} />
                    <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 4 }}>From your account, update it in My Profile if it's changed.</div>
                  </div>
                  <div>
                    <label className="form-label">Alternate Phone Number <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
                    <input className="form-input" type="tel" value={formatPhoneDisplay(linkForm.other_guardian_phone)} onChange={handlePhoneInput('other_guardian_phone')} placeholder="+63 000 000 0000" maxLength={16} />
                    {phoneNotes.other_guardian_phone && <div style={{ fontSize: 11.5, color: '#DC2626', fontWeight: 600, marginTop: 4 }}>{phoneNotes.other_guardian_phone}</div>}
                  </div>
                </div>
              </>
            )}

            {linkStep === 3 && (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 4, paddingBottom: 8, borderBottom: '1px solid #E2E8F0' }}>
                  <i className="fa-solid fa-child-reaching" style={{ marginRight: 8, color: '#4F46E5' }} />Development &amp; Functional Information
                </div>
                <div style={{ fontSize: 11.5, color: '#94A3B8', marginBottom: 12 }}>Helps the clinic prepare for your child's first assessment. Fields marked * are required.</div>

                {(() => {
                  const bySection = {};
                  devFields.forEach(f => { (bySection[f.section] ||= []).push(f); });
                  return Object.entries(bySection).map(([section, fields]) => (
                    <div key={section}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155', marginBottom: 8 }}>{section}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                        {fields.filter(f => !devFieldHidden(f, devFields, linkForm.dev_functional_data)).map(f => (
                          <div key={f.id} style={f.field_type === 'text' && f.label.length > 30 ? { gridColumn: '1/-1' } : undefined}>
                            <label className="form-label">{f.label}{f.required ? ' *' : <span style={{ fontWeight: 400, color: '#94A3B8' }}> (optional)</span>}</label>
                            <DevFunctionalField
                              field={f}
                              data={linkForm.dev_functional_data}
                              onChange={(id, val) => setLinkForm(form => ({ ...form, dev_functional_data: { ...form.dev_functional_data, [id]: val } }))}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid #E2E8F0' }}>
              {linkStep === 1 ? (
                <button type="button" onClick={() => { setLinkChildModal(false); setLinkErr(''); setLinkConsent(false); setConsentChecked(false); setLinkStep(1); }} style={{ padding: '10px 20px', background: '#F1F5F9', color: '#475569', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              ) : (
                <button type="button" onClick={prevLinkStep} style={{ padding: '10px 20px', background: '#F1F5F9', color: '#475569', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}><i className="fa-solid fa-arrow-left" style={{ marginRight: 6 }} />Back</button>
              )}
              {linkStep < 3 ? (
                <button type="button" onClick={nextLinkStep} style={{ padding: '10px 24px', background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Next<i className="fa-solid fa-arrow-right" style={{ marginLeft: 6 }} /></button>
              ) : (
                <button type="button" disabled={linkBusy} onClick={submitLinkChild} style={{ padding: '10px 24px', background: '#1F4E9E', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: linkBusy ? .7 : 1 }}>
                  {linkBusy ? 'Submitting...' : 'Register Child'}
                </button>
              )}
            </div>
          </div>
          )}
        </Modal>
      )}
    </>
  );
}

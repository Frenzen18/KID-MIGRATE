import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { api } from '../../api.js';
import { useToast, Modal } from '../../components/ui.jsx';
import BrandLogo from '../../components/BrandLogo.jsx';
import GasProgressChart from '../../components/GasProgressChart.jsx';
import DevFunctionalField, { devFieldHidden } from '../../components/DevFunctionalField.jsx';
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
  if (!child.assigned_therapist_name && !child.therapy_type) return ['Initial Assessment'];
  const map = { OT: ['Occupational Therapy'], Speech: ['Speech Therapy'], Both: ['Occupational Therapy', 'Speech Therapy'] };
  return map[child.therapy_type] || ['Initial Assessment'];
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

export default function ParentPortal() {
  const { logout, user, updateUser, updateProfile } = useAuth();
  const nav = useNavigate();
  const toast = useToast();

  /* ── Navigation state ── */
  const [page, setPage] = useState('dashboard');
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
  const [reservations, setReservations] = useState(null);
  const [payments, setPayments] = useState(null);
  const [notifications, setNotifications] = useState(null);
  const [loading, setLoading] = useState(true);
  // Development & Functional Information, the admin-configurable field list
  // rendered on the child-linking form (see server/routes/devFunctionalFields.js).
  const [devFields, setDevFields] = useState([]);

  /* ── Booking page state ── */
  const [reservationDate, setReservationDate] = useState(minBookableDateStr());
  const [selectedSlot, setSelectedSlot] = useState('');
  const [slotsForDate, setSlotsForDate] = useState([]);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [slotError, setSlotError] = useState(false);
  const [bookingSessionType, setBookingSessionType] = useState('');

  /* ── Progress page state ── */

  /* ── Payment page state ── */
  const [payTab, setPayTab] = useState('checkout');

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
    const qs = 'date=' + reservationDate + (child?.id ? '&client_id=' + child.id : '');
    api('/reservations/slots?' + qs)
      .then(data => { if (!cancelled) setSlotsForDate(data); })
      .catch(() => { if (!cancelled) setSlotsForDate([]); });
    return () => { cancelled = true; };
  }, [reservationDate, activeChild, children]);

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
  function goPage(key) { setPage(key); setSidebarOpen(false); window.scrollTo(0, 0); }
  function toggleNotif() { setProfileOpen(false); setNotifOpen(o => !o); }
  function toggleProfile() { setNotifOpen(false); setProfileOpen(o => !o); }
  function doLogout() { logout(); nav('/login'); }

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
    if (!PH_PHONE.test(contactInput)) { setContactErr('Phone number must be +63 followed by 10 digits (e.g. +639171234567).'); return; }
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
  const upcomingReservations = (reservations || []).filter(r => r.date >= todayStr() && ['awaiting_payment', 'pending', 'confirmed', 'rescheduled'].includes(r.status));
  const nextSession = upcomingReservations.find(r => r.status === 'confirmed') || upcomingReservations[0];

  /* ── Booking handlers ── */
  function pickSlot(label) { setSelectedSlot(label); setSlotError(false); }
  function changeDate(val) { setReservationDate(val); setSelectedSlot(''); setSlotError(false); }
  async function submitReservation() {
    if (bookingBusy) return; // guard against double-click / double-submit race
    if (!reservationDate) {
      toast('Please select a reservation date.', 'fa-triangle-exclamation');
      return;
    }
    if (!selectedSlot) {
      toast('Please select a time slot before submitting.', 'fa-triangle-exclamation');
      setSlotError(true);
      return;
    }
    if (isSlotPast(reservationDate, selectedSlot)) {
      toast('That time slot has already passed. Please pick another.', 'fa-triangle-exclamation');
      setSelectedSlot('');
      return;
    }
    if (!children || !children.length) {
      toast('No child linked to your account yet', 'fa-circle-exclamation');
      return;
    }
    if (!bookingSessionType) {
      toast('Please select a session type before submitting.', 'fa-triangle-exclamation');
      return;
    }
    if (upcomingReservations.length > 0) {
      toast('You already have an upcoming booking for this child. You can only book one at a time, cancel it under "My Booking Requests", or wait until its date has passed, before submitting a new one.', 'fa-triangle-exclamation');
      return;
    }
    setBookingBusy(true);
    try {
      const { payment, ...res } = await api('/reservations', {
        method: 'POST',
        body: {
          date: reservationDate,
          time_slot: selectedSlot,
          client_id: children[0].id,
          session_type: bookingSessionType
        }
      });
      setReservations(prev => [...(prev || []), res]);
      setSelectedSlot('');
      // Refresh slots, same client_id as the booking above, so the list stays
      // narrowed to that child's Assigned Therapist if one is set.
      api('/reservations/slots?date=' + reservationDate + '&client_id=' + children[0].id).then(setSlotsForDate).catch(() => {});
      toast('Slot held, complete payment to confirm your booking', 'fa-calendar-check');
      // No more staff-approved "request", the slot is held and this goes
      // straight to QRPh checkout, paying is what actually confirms it.
      if (payment) generateQr(payment);
    } catch (e) {
      toast(e.message || 'Failed to submit booking', 'fa-circle-exclamation');
    } finally {
      setBookingBusy(false);
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
    if (altPhone && !PH_PHONE.test(altPhone)) return 'Alternate phone number must be +63 followed by 10 digits (e.g. +639171234567).';
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, padding: '14px 18px', borderRadius: 14, background: 'linear-gradient(135deg,#0EA5E9,#0D9488)', color: '#fff' }}>
          <div className="act-avatar" style={{ background: 'rgba(255,255,255,.18)', color: '#fff', width: 44, height: 44 }}><i className="fa-solid fa-child" /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.06em', opacity: .85 }}>Active Child Profile</div>
            <div style={{ fontFamily: "'Poppins',sans-serif", fontSize: 17, fontWeight: 700 }}>{child.full_name}</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 12.5, opacity: .95 }}>{child.client_code} · {child.therapy_type ? child.therapy_type + ' Program' : 'For assessment'}{age ? ' · Age ' + age : ''}</div>
        </div>

        {/* Progress overview */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
          <div className="card" style={{ padding: '22px 24px' }}>
            <div className="section-title" style={{ marginBottom: 4 }}>{child.full_name}'s Record</div>
            <div className="section-sub" style={{ marginBottom: 16 }}>{child.client_code} · {child.therapy_type ? child.therapy_type + ' Program' : 'Awaiting assessment'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Diagnosis</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{child.diagnosis || '-'}</div></div>
              <div><div style={{ fontSize: 10.5, color: '#94A3B8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 2 }}>Assigned Therapist</div><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>{child.assigned_therapist_name || 'Not yet assigned'}</div></div>
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
    const hasActiveBooking = upcomingReservations.length > 0;
    const activeBooking = upcomingReservations[0];
    const bookingChild = activeChild || (hasChildren ? children[0] : null);
    const sessionOptions = sessionTypesFor(bookingChild);

    return (
      <div className="spa-page" id="spa-booking">
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Book or Reschedule a Session</h1>
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Self-service reservations with real-time slot availability.</p>
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
                {hasActiveBooking && activeBooking.status === 'awaiting_payment' && (
                  <div style={{ background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 9, padding: '12px 14px', marginBottom: 16, fontSize: 12.5, color: '#92400E', display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                    <i className="fa-solid fa-hourglass-half" style={{ marginTop: 1 }} />
                    <span style={{ flex: 1 }}>Your slot on {fmtDate(activeBooking.date)} · {activeBooking.time_slot} is held, awaiting your payment. Complete it soon, unpaid holds are released automatically.</span>
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
                <div style={{ marginBottom: 14, opacity: hasActiveBooking ? .55 : 1, pointerEvents: hasActiveBooking ? 'none' : 'auto' }}>
                  <label className="form-label">Session Type</label>
                  {sessionOptions.length <= 1 ? (
                    <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: '#475569', background: '#F8FAFC', fontWeight: 600 }}>
                      {sessionOptions[0] || 'No eligible session type'}
                    </div>
                  ) : (
                    <select className="form-select" value={bookingSessionType} onChange={e => setBookingSessionType(e.target.value)}>
                      {sessionOptions.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                  {!bookingChild?.assigned_therapist_name && !bookingChild?.therapy_type && (
                    <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 5 }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Only an Initial Assessment can be booked until the clinic assigns a therapy type and therapist.</div>
                  )}
                </div>
                <div style={{ marginBottom: 14, opacity: hasActiveBooking ? .55 : 1, pointerEvents: hasActiveBooking ? 'none' : 'auto' }}>
                  <label className="form-label">Requested Date</label>
                  <input type="date" className="form-input" value={reservationDate} min={minBookableDateStr()} onChange={e => changeDate(e.target.value)} disabled={hasActiveBooking} />
                </div>
                <div style={{ marginBottom: 14, opacity: hasActiveBooking ? .55 : 1, pointerEvents: hasActiveBooking ? 'none' : 'auto' }}>
                  <label className="form-label" style={slotError ? { color: '#DC2626' } : undefined}>Available Time Slots {slotError && <span style={{ fontWeight: 400 }}>- please pick one</span>}</label>
                  <div className="slot-grid" style={slotError ? { border: '1px solid #FCA5A5', borderRadius: 10, padding: 8, background: '#FEF2F2' } : undefined}>
                    {slotsForDate.length === 0 && (
                      <div style={{ fontSize: 12.5, color: '#94A3B8', padding: '6px 2px' }}>No time slots for this date, no therapists are on shift.</div>
                    )}
                    {slotsForDate.map(s => {
                      const t = s.time_slot;
                      const full = s.available <= 0;
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
                          {!s.lunch_break && !full && !past && s.capacity > 1 && <span style={{ fontSize: 10, fontWeight: 400 }}> · {s.available} left</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 12, color: '#64748B', maxWidth: 340 }}><i className="fa-solid fa-shield-halved" style={{ color: '#0D9488', marginRight: 4 }} />Conflict prevention is active. Double-booked slots are automatically blocked.</div>
                  <button className="btn-primary" disabled={bookingBusy || hasActiveBooking} onClick={submitReservation}>
                    {bookingBusy ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Submitting…</> : 'Submit Booking Request'}
                  </button>
                </div>
              </div>
            </div>

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
                    : r.status === 'awaiting_payment' ? <span className="pill pill-amber">Awaiting Payment</span>
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
                        <button className="btn-primary" style={{ fontSize: 11, padding: '5px 10px', marginTop: 6 }} onClick={() => {
                          const p = (payments || []).find(pm => pm.reservation_id === r.id);
                          if (p) generateQr(p);
                        }}>Complete Payment</button>
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
          <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Gateway integration · Itemized balances · Download invoices</p>
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
                  {pendingPayments.map(p => (
                    <div className="balance-row" key={p.id}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{p.invoice_no || 'Session'}</div>
                        <div style={{ fontSize: 11.5, color: '#94A3B8' }}>{fmtDate((p.created_at || '').slice(0, 10))} · <span className="pill pill-amber" style={{ fontSize: 9 }}>{p.status}</span></div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>₱{Number(p.amount).toLocaleString()}</span>
                        <button className="btn-primary" style={{ fontSize: 12, padding: '8px 14px' }} disabled={qrBusy} onClick={() => generateQr(p)}>
                          <i className="fa-solid fa-qrcode" style={{ marginRight: 5 }} />Pay with QRPh
                        </button>
                      </div>
                    </div>
                  ))}
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
    const unread = allNotifs.filter(n => !n.read);
    const read = allNotifs.filter(n => n.read);

    async function markRead(id) {
      try {
        await api('/notifications/' + id + '/read', { method: 'PUT' });
        setNotifications(prev => (prev || []).map(n => n.id === id ? { ...n, read: true } : n));
        toast('Notification marked as read', 'fa-check');
      } catch (e) {
        toast('Failed to mark read', 'fa-circle-exclamation');
      }
    }

    return (
      <div className="spa-page" id="spa-notifications">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Notifications</h1>
            <p style={{ fontSize: 13.5, color: '#64748B', margin: 0 }}>Session reminders, rescheduling changes, and payment updates.</p>
          </div>
        </div>

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(165px,1fr))', gap: 16, marginBottom: 22 }}>
          <div className="card stat-card" style={{ borderTop: '3px solid #0EA5E9' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Unread</div><div className="stat-value">{unread.length}</div><div className={unread.length > 0 ? 'stat-change down' : 'stat-change up'}>{unread.length > 0 ? 'Needs attention' : 'All caught up'}</div></div><div className="stat-icon" style={{ background: '#E0F2FE', color: '#0EA5E9' }}><i className="fa-solid fa-bell" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #10B981' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Total</div><div className="stat-value">{allNotifs.length}</div><div className="stat-change up">All notifications</div></div><div className="stat-icon" style={{ background: '#DCFCE7', color: '#10B981' }}><i className="fa-solid fa-inbox" /></div></div></div>
          <div className="card stat-card" style={{ borderTop: '3px solid #F59E0B' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><div className="stat-label">Next Session</div><div className="stat-value">{nextSession ? fmtShortDate(nextSession.date) : '-'}</div><div className="stat-change up">{nextSession ? nextSession.time_slot : 'None scheduled'}</div></div><div className="stat-icon" style={{ background: '#FEF3C7', color: '#F59E0B' }}><i className="fa-solid fa-calendar-check" /></div></div></div>
        </div>

        {/* Notification list */}
        {allNotifs.length === 0 ? (
          <div className="card" style={{ padding: '40px 20px' }}>
            <EmptyState icon="fa-bell-slash" title="No Notifications" description="You don't have any notifications yet. You'll receive updates about sessions, payments, and schedule changes here." />
          </div>
        ) : (
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><div className="section-title">All Notifications</div><div className="section-sub">Session reminders, rescheduling changes, and payment updates</div></div>
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
                  {!n.read && <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => markRead(n.id)}>Mark read</button>}
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
                    <div key={n.id || i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', background: !n.read ? '#F0F9FF' : '#fff', borderBottom: '1px solid #F8FAFC' }}>
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
              <input className="form-input" type="tel" value={contactInput} onChange={handleContactInput} placeholder="+639XXXXXXXXX" maxLength={13} />
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
                    <input className="form-input" value={linkForm.last_name} onChange={e => setLinkForm(f => ({ ...f, last_name: e.target.value }))} placeholder="Child's last name" required />
                  </div>
                  <div>
                    <label className="form-label">First Name *</label>
                    <input className="form-input" value={linkForm.first_name} onChange={e => setLinkForm(f => ({ ...f, first_name: e.target.value }))} placeholder="Child's first name" required />
                  </div>
                  <div>
                    <label className="form-label">Middle Name <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
                    <input className="form-input" value={linkForm.middle_name} onChange={e => setLinkForm(f => ({ ...f, middle_name: e.target.value }))} placeholder="Child's middle name" />
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
                    <input className="form-input" value={linkForm.allergies} onChange={e => setLinkForm(f => ({ ...f, allergies: e.target.value }))} placeholder="Food, medicine, etc." />
                  </div>
                  <div>
                    <label className="form-label">Daily Medication <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
                    <input className="form-input" value={linkForm.daily_medication} onChange={e => setLinkForm(f => ({ ...f, daily_medication: e.target.value }))} placeholder="Only if relevant to therapy sessions" />
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
                    <input className="form-input" type="tel" value={user?.contact || ''} disabled style={{ background: '#F1F5F9' }} />
                    <div style={{ fontSize: 11.5, color: '#94A3B8', marginTop: 4 }}>From your account, update it in My Profile if it's changed.</div>
                  </div>
                  <div>
                    <label className="form-label">Alternate Phone Number <span style={{ fontWeight: 400, color: '#94A3B8' }}>(optional)</span></label>
                    <input className="form-input" type="tel" value={linkForm.other_guardian_phone} onChange={handlePhoneInput('other_guardian_phone')} placeholder="+639XXXXXXXXX" maxLength={13} />
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

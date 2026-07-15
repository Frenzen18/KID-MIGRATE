import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { useToast } from '../../components/ui.jsx';
import { api } from '../../api.js';
import '../admin/admin.css';
import AdminModals from '../admin/AdminModals.jsx';

import Dashboard from '../admin/pages/Dashboard.jsx';
import Clients from '../admin/pages/Clients.jsx';
import Milestones from '../admin/pages/Milestones.jsx';
import Notifications from '../admin/pages/Notifications.jsx';
import Reports from '../admin/pages/Reports.jsx';
import MyCalendar from './MyCalendar.jsx';

/**
 * Therapist portal, shared by both the 'ot' and 'speech' roles (rendered at
 * /ot and /speech respectively), reusing the exact same real admin page
 * components Staff/Admin use, with role-based scoping added to each:
 *   - Dashboard: only the Milestone Trends tab, scoped to their own discipline.
 *   - Booking Schedule: a therapist-only page (MyCalendar.jsx), their own
 *     shift hours and own booked sessions only, never the whole clinic's.
 *   - Client Records: only 3.1 (no scheduling/financial tabs), filtered to
 *     children they actually have real session history with.
 *   - Milestone Scoreboard: discipline-locked (own GAS tab/entries only).
 *   - Notifications: only the Reminders tab, scoped to their own sessions.
 *   - Reports: same reduced set staff gets (no Security Audit / Milestone report).
 * User Management, CMS, and Payments aren't part of this portal.
 */
const THERAPIST_PAGE_KEYS = ['dashboard', 'booking', 'clients', 'milestones', 'notifications', 'reports'];

/** "5 min ago" / "3 hrs ago" / "Jun 27" style relative timestamp for notification rows. */
function relativeTime(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return min + ' min ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hr ago' : ' hrs ago');
  const day = Math.floor(hr / 24);
  if (day < 7) return day + (day === 1 ? ' day ago' : ' days ago');
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function initials(name) {
  return (name || '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'T';
}

export default function TherapistPortal() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const roleLabel = user?.role === 'speech' ? 'Speech-Language Therapist' : 'Occupational Therapist';
  const portalLabel = user?.role === 'speech' ? 'Speech Therapy Portal' : 'Occupational Therapy Portal';

  const [page, setPage] = useState(() => {
    const saved = localStorage.getItem('kid_therapist_page');
    return THERAPIST_PAGE_KEYS.includes(saved) ? saved : 'dashboard';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const [notifs, setNotifs] = useState([]);
  const [notifDot, setNotifDot] = useState(false);

  /* shared modal system, identical to AdminPortal's, same AdminModals component */
  const [modal, setModal] = useState(null);

  const fetchNotifs = () => {
    api('/notifications')
      .then(data => {
        setNotifs(data || []);
        setNotifDot((data || []).some(n => !n.read));
      })
      .catch(() => {});
  };
  useEffect(() => {
    fetchNotifs();
    const iv = setInterval(fetchNotifs, 30000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    function onDoc(e) {
      if (!e.target.closest('#notif-btn') && !e.target.closest('#notif-panel')) setNotifOpen(false);
      if (!e.target.closest('#profile-btn') && !e.target.closest('#profile-panel')) setProfileOpen(false);
    }
    function onEsc(e) { if (e.key === 'Escape') setModal(null); }
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onEsc); };
  }, []);

  function go(key) {
    // Reminders/links can point at pages this portal doesn't have (e.g. 'reservations',     // there's no booking page here); fall back to Client Records rather than blanking
    // the whole content area on an unrecognized key.
    const target = THERAPIST_PAGE_KEYS.includes(key) ? key : 'clients';
    setPage(target);
    localStorage.setItem('kid_therapist_page', target);
    setSidebarOpen(false);
    window.scrollTo(0, 0);
    const c = document.getElementById('content');
    if (c) c.scrollTop = 0;
  }

  function toggleNotif() { setProfileOpen(false); setNotifOpen(o => !o); }
  function toggleProfile() { setNotifOpen(false); setProfileOpen(o => !o); }

  async function markAllRead() {
    try {
      await api('/notifications/read-all', { method: 'PUT' });
      setNotifs(list => list.map(n => ({ ...n, read: true })));
      setNotifDot(false);
      toast('All notifications marked as read', 'fa-check-double');
    } catch (e) {
      toast('Failed to mark notifications read', 'fa-triangle-exclamation');
    }
  }

  async function markNotifRead(id) {
    try {
      await api('/notifications/' + id + '/read', { method: 'PUT' });
      setNotifs(list => {
        const next = list.map(n => (n.id === id ? { ...n, read: true } : n));
        setNotifDot(next.some(n => !n.read));
        return next;
      });
    } catch (e) {
      toast('Failed to mark notification read', 'fa-triangle-exclamation');
    }
  }

  function doLogout() { logout(); nav('/login'); }

  const openModal = (id, data) => setModal({ id, data: data || {} });
  const closeModal = () => setModal(null);

  const unreadCount = notifs.filter(n => !n.read).length;

  const nav_item = (key, icon, label, badge, badgeClass) => (
    <a className={'nav-item' + (page === key ? ' active' : '')} href="#" onClick={e => { e.preventDefault(); go(key); }}>
      <span className="icon"><i className={'fa-solid ' + icon} /></span> {label}
      {badge != null && <span className={'nav-badge' + (badgeClass ? ' ' + badgeClass : '')}>{badge}</span>}
    </a>
  );

  const pageProps = { go, toast, openModal, role: user?.role };

  return (
    <>
      <aside id="sidebar" className={sidebarOpen ? 'open' : ''}>
        <div className="logo-area">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: 'linear-gradient(135deg,#0EA5E9,#0D9488)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className="fa-solid fa-child-reaching" style={{ color: '#fff', fontSize: 17 }} />
            </div>
            <div>
              <div style={{ fontFamily: "'Poppins',sans-serif", fontWeight: 700, fontSize: 16, color: '#0F172A', lineHeight: 1.1 }}>KID</div>
              <div style={{ fontSize: 10.5, color: '#64748B', fontWeight: 500 }}>{portalLabel}</div>
            </div>
          </div>
        </div>
        <nav id="sidebar-nav">
          <div className="nav-label">Overview</div>
          {nav_item('dashboard', 'fa-gauge-high', 'Dashboard')}
          {nav_item('booking', 'fa-calendar-days', 'Booking Schedule')}
          <div className="nav-label">My Caseload</div>
          {nav_item('clients', 'fa-child', 'Client Records')}
          {nav_item('milestones', 'fa-trophy', 'Milestone Scoreboard')}
          <div className="nav-label">System</div>
          {nav_item('notifications', 'fa-bell', 'Notifications')}
          {nav_item('reports', 'fa-chart-bar', 'Reports')}
        </nav>
      </aside>

      <div id="main">
        <header id="topnav">
          <button id="hamburger" className="topnav-btn" onClick={() => setSidebarOpen(o => !o)}><i className="fa-solid fa-bars" /></button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
            <button className="topnav-btn" data-tip="Help"><i className="fa-regular fa-circle-question" /></button>
            <div style={{ position: 'relative' }}>
              <button className="topnav-btn" data-tip="Notifications" id="notif-btn" onClick={toggleNotif}><i className="fa-regular fa-bell" />{notifDot && <span className="notif-dot" />}</button>
              <div id="notif-panel" className={notifOpen ? 'open' : ''}>
                <div style={{ padding: '14px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: "'Poppins',sans-serif", fontWeight: 600, fontSize: 14, color: '#0F172A' }}>
                    Notifications{unreadCount > 0 && <span style={{ background: '#EF4444', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, marginLeft: 6 }}>{unreadCount}</span>}
                  </span>
                  <span style={{ fontSize: 11, color: '#0EA5E9', cursor: 'pointer', fontWeight: 500 }} onClick={markAllRead}>Mark all read</span>
                </div>
                <div className="notif-items" style={{ maxHeight: 360, overflowY: 'auto' }}>
                  {notifs.length === 0 && (
                    <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 12.5, color: '#94A3B8' }}>No notifications yet</div>
                  )}
                  {notifs.slice(0, 8).map(n => (
                    <div key={n.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', cursor: n.read ? 'default' : 'pointer', background: !n.read ? '#F0F9FF' : '#fff', borderBottom: '1px solid #F8FAFC' }} onClick={() => !n.read && markNotifRead(n.id)}>
                      <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: !n.read ? '#DBEAFE' : '#F1F5F9', color: !n.read ? '#2563EB' : '#94A3B8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <i className={'fa-solid ' + (n.icon || 'fa-bell')} style={{ fontSize: 13 }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: '#0F172A', fontWeight: !n.read ? 600 : 500, lineHeight: 1.3 }}>{n.title}</div>
                        {n.body && <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.body}</div>}
                        <div style={{ fontSize: 11, color: '#CBD5E1', marginTop: 3 }}>{relativeTime(n.created_at)}</div>
                      </div>
                      {!n.read && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#0EA5E9', flexShrink: 0, marginTop: 4 }} />}
                    </div>
                  ))}
                </div>
                <div style={{ padding: '12px 16px', borderTop: '1px solid #F1F5F9', textAlign: 'center' }}>
                  <a href="#" onClick={e => { e.preventDefault(); setNotifOpen(false); go('notifications'); }} style={{ fontSize: 12, color: '#0EA5E9', cursor: 'pointer', fontWeight: 500, textDecoration: 'none' }}>View all notifications →</a>
                </div>
              </div>
            </div>
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '4px 6px', borderRadius: 10 }} id="profile-btn" onClick={toggleProfile}>
                <div className="avatar">{initials(user?.name)}</div>
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', fontFamily: "'Poppins',sans-serif" }}>{user?.name || 'Therapist'}</span>
                  <span style={{ fontSize: 11, color: '#64748B' }}>{roleLabel}</span>
                </div>
                <i className="fa-solid fa-chevron-down" style={{ fontSize: 10, color: '#94A3B8', marginLeft: 2 }} />
              </div>
              <div id="profile-panel" className={profileOpen ? 'open' : ''}>
                <a className="pp-item" href="#" onClick={e => { e.preventDefault(); setProfileOpen(false); doLogout(); }} style={{ color: '#EF4444', textDecoration: 'none' }}><i className="fa-solid fa-arrow-right-from-bracket" style={{ width: 14 }} /> Logout</a>
              </div>
            </div>
          </div>
        </header>

        <main id="content">
          {page === 'dashboard' && <Dashboard {...pageProps} />}
          {page === 'booking' && <MyCalendar {...pageProps} therapistName={user?.name || ''} />}
          {page === 'clients' && <Clients {...pageProps} scopeToTherapist therapistName={user?.name || ''} />}
          {page === 'milestones' && <Milestones {...pageProps} />}
          {page === 'notifications' && <Notifications {...pageProps} />}
          {page === 'reports' && <Reports toast={toast} role={user?.role} />}
        </main>
      </div>

      <AdminModals modal={modal} closeModal={closeModal} toast={toast} />
    </>
  );
}

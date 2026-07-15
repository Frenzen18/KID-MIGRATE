import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { useToast } from '../../components/ui.jsx';
import { api } from '../../api.js';
import './admin.css';
import AdminModals from './AdminModals.jsx';

import Dashboard from './pages/Dashboard.jsx';
import Users from './pages/Users.jsx';
import Clients from './pages/Clients.jsx';
import Cms from './pages/Cms.jsx';
import Milestones from './pages/Milestones.jsx';
import Reservations from './pages/Reservations.jsx';
import Payments from './pages/Payments.jsx';
import Notifications from './pages/Notifications.jsx';
import Audit from './pages/Audit.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';

/** All page keys the sidebar can navigate to, used to validate the page restored from localStorage on reload. */
const ADMIN_PAGE_KEYS = [
  'dashboard', 'users', 'clients', 'cms', 'milestones', 'reservations',
  'payments', 'notifications', 'audit', 'reports', 'settings'
];

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

export default function AdminPortal() {
  const { logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();

  const [page, setPage] = useState(() => {
    const saved = localStorage.getItem('kid_admin_page');
    return ADMIN_PAGE_KEYS.includes(saved) ? saved : 'dashboard';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const [notifs, setNotifs] = useState([]);
  const [notifDot, setNotifDot] = useState(false);
  const [pendingReservations, setPendingReservations] = useState(0);

  /* shared modal system (ported from shared.js openModal/closeModal) */
  const [modal, setModal] = useState(null);

  /* Real notifications, fetched from /api/notifications, refreshed periodically so
     the bell and inbox reflect what's actually happening (bookings, payments, etc.). */
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

  /* Real sidebar badge count for pending bookings, the nav badge used to be a
     hardcoded placeholder number regardless of actual pending reservations. */
  useEffect(() => {
    function fetchPending() {
      api('/reservations?status=pending')
        .then(data => setPendingReservations((data || []).length))
        .catch(() => {});
    }
    fetchPending();
    const iv = setInterval(fetchPending, 30000);
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
    setPage(key);
    localStorage.setItem('kid_admin_page', key);
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

  function doLogout() { logout(); nav('/admin/login'); }

  const openModal = (id, data) => setModal({ id, data: data || {} });
  const closeModal = () => setModal(null);

  const unreadCount = notifs.filter(n => !n.read).length;

  const nav_item = (key, icon, label, badge, badgeClass) => (
    <a className={'nav-item' + (page === key ? ' active' : '')} href="#" data-spa={key} onClick={e => { e.preventDefault(); go(key); }}>
      <span className="icon"><i className={'fa-solid ' + icon} /></span> {label}
      {badge != null && <span className={'nav-badge' + (badgeClass ? ' ' + badgeClass : '')}>{badge}</span>}
    </a>
  );

  const pageProps = { go, toast, openModal };

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
              <div style={{ fontSize: 10.5, color: '#64748B', fontWeight: 500 }}>Admin Dashboard</div>
            </div>
          </div>
        </div>
        <nav id="sidebar-nav">
          <div className="nav-label">Overview</div>
          {nav_item('dashboard', 'fa-gauge-high', 'Dashboard')}
          <div className="nav-label">Management</div>
          {nav_item('users', 'fa-users', 'User Management')}
          {nav_item('clients', 'fa-child', 'Client Records')}
          {nav_item('cms', 'fa-layer-group', 'CMS')}
          {nav_item('milestones', 'fa-trophy', 'Milestone Scoreboard')}
          {nav_item('reservations', 'fa-calendar-check', 'Booking and Appointment', pendingReservations > 0 ? pendingReservations : null, 'red')}
          {nav_item('payments', 'fa-credit-card', 'Payment Management')}
          <div className="nav-label">System</div>
          {nav_item('notifications', 'fa-bell', 'Notifications', unreadCount > 0 ? unreadCount : null)}
          {nav_item('audit', 'fa-file-shield', 'Security Audit Logs')}
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
                <div className="avatar">SA</div>
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A', fontFamily: "'Poppins',sans-serif" }}>Dr. Ana Reyes</span>
                  <span style={{ fontSize: 11, color: '#64748B' }}>System Administrator</span>
                </div>
                <i className="fa-solid fa-chevron-down" style={{ fontSize: 10, color: '#94A3B8', marginLeft: 2 }} />
              </div>
              <div id="profile-panel" className={profileOpen ? 'open' : ''}>
                <a className="pp-item" href="#" onClick={e => { e.preventDefault(); setProfileOpen(false); go('settings'); }} style={{ textDecoration: 'none' }}><i className="fa-solid fa-gear" style={{ color: '#64748B', width: 14 }} /> Settings</a>
                <div style={{ height: 1, background: '#F1F5F9', margin: '4px 0' }} />
                <a className="pp-item" href="#" onClick={e => { e.preventDefault(); setProfileOpen(false); doLogout(); }} style={{ color: '#EF4444', textDecoration: 'none' }}><i className="fa-solid fa-arrow-right-from-bracket" style={{ width: 14 }} /> Logout</a>
              </div>
            </div>
          </div>
        </header>

        <main id="content">
          {page === 'dashboard' && <Dashboard {...pageProps} />}
          {page === 'users' && <Users {...pageProps} />}
          {page === 'clients' && <Clients {...pageProps} />}
          {page === 'cms' && <Cms {...pageProps} />}
          {page === 'milestones' && <Milestones {...pageProps} />}
          {page === 'reservations' && <Reservations {...pageProps} />}
          {page === 'payments' && <Payments {...pageProps} />}
          {page === 'notifications' && <Notifications {...pageProps} />}
          {page === 'audit' && <Audit {...pageProps} />}
          {page === 'reports' && <Reports {...pageProps} />}
          {page === 'settings' && <Settings {...pageProps} />}
        </main>
      </div>

      <AdminModals modal={modal} closeModal={closeModal} toast={toast} />
    </>
  );
}


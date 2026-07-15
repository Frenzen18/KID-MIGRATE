import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('kid_user')) || null; } catch { return null; }
  });

  // On app load, verify the stored session with the server. A deleted or
  // deactivated account (or an expired token) gets logged out immediately
  // instead of living on in localStorage.
  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me')
      .then(data => {
        setUser(data.user);
        localStorage.setItem('kid_user', JSON.stringify(data.user));
      })
      .catch(err => {
        // Only log out when the server actually rejected the session (401/403).
        // A network hiccup (server not running) shouldn't wipe the session.
        if (err.data) {
          localStorage.removeItem('kid_token');
          localStorage.removeItem('kid_user');
          setUser(null);
        }
      });
  }, []);

  // Security: the browser's back/forward buttons can restore a frozen
  // snapshot of a protected page straight from bfcache, bypassing React
  // entirely, so a logged-out user could still "see" the portal they were
  // on. `pageshow` with `event.persisted === true` fires exactly when a
  // page is restored from bfcache; re-check the real session (and re-sync
  // local state) whenever that happens, and also on regular back/forward
  // navigation (`popstate`) as a second line of defense.
  useEffect(() => {
    function revalidate() {
      const token = getToken();
      if (!token) {
        // No token anymore (logged out in this or another tab), make sure
        // React state agrees, so RequireAuth redirects instead of showing
        // a bfcache-restored portal page.
        setUser(null);
        return;
      }
      api('/auth/me')
        .then(data => {
          setUser(data.user);
          localStorage.setItem('kid_user', JSON.stringify(data.user));
        })
        .catch(err => {
          if (err.data) {
            localStorage.removeItem('kid_token');
            localStorage.removeItem('kid_user');
            setUser(null);
          }
        });
    }
    function onPageShow(e) {
      if (e.persisted) revalidate();
    }
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('popstate', revalidate);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('popstate', revalidate);
    };
  }, []);

  async function login(email, password, portal) {
    const data = await api('/auth/login', { method: 'POST', body: { email, password, ...(portal ? { portal } : {}) } });
    localStorage.setItem('kid_token', data.token);
    localStorage.setItem('kid_user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  }

  /** Self-service parent/guardian registration. The account must verify its email before logging in. */
  async function signup({ firstName, lastName, email, password, contact }) {
    return api('/auth/signup', {
      method: 'POST',
      body: { first_name: firstName, last_name: lastName, email, password, contact }
    });
  }

  function logout() {
    localStorage.removeItem('kid_token');
    localStorage.removeItem('kid_user');
    localStorage.removeItem('kid_admin_page');
    setUser(null);
  }

  /** Merge fields into the current user (e.g. privacy_consent_at after consenting). */
  function updateUser(patch) {
    setUser(u => {
      if (!u) return u;
      const next = { ...u, ...patch };
      localStorage.setItem('kid_user', JSON.stringify(next));
      return next;
    });
  }

  /** Forced first-login password change (or a general self-service change). Clears must_change_password on success. */
  async function changePassword(currentPassword, newPassword) {
    await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    updateUser({ must_change_password: false });
  }

  /** Self-service update of your own contact number (e.g. the "My Profile" panel). */
  async function updateProfile({ contact }) {
    const data = await api('/auth/me', { method: 'PUT', body: { contact } });
    updateUser({ contact: data.contact });
    return data;
  }

  return <AuthCtx.Provider value={{ user, login, signup, logout, updateUser, changePassword, updateProfile }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);

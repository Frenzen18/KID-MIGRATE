import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, refreshAccessToken } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('kid_user')) || null; } catch { return null; }
  });

  // On app load, verify the stored session with the server. A deleted or
  // deactivated account (or an expired token) gets logged out immediately
  // instead of living on in sessionStorage. sessionStorage (not localStorage)
  // is deliberate: it's scoped to this one tab/window, so a login in one tab
  // never silently "appears" in another tab of the same browser sharing the
  // same origin, someone else on a shared computer stays confined to their
  // own tab.
  useEffect(() => {
    if (!getToken()) return;
    api('/auth/me')
      .then(data => {
        setUser(data.user);
        sessionStorage.setItem('kid_user', JSON.stringify(data.user));
      })
      .catch(err => {
        // Only log out when the server actually rejected the session (401/403).
        // A network hiccup (server not running) shouldn't wipe the session.
        if (err.data) {
          sessionStorage.removeItem('kid_token');
          sessionStorage.removeItem('kid_user');
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
          sessionStorage.setItem('kid_user', JSON.stringify(data.user));
        })
        .catch(err => {
          if (err.data) {
            sessionStorage.removeItem('kid_token');
            sessionStorage.removeItem('kid_user');
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
    sessionStorage.setItem('kid_token', data.token);
    sessionStorage.setItem('kid_refresh_token', data.refreshToken);
    sessionStorage.setItem('kid_token_expires_at', String(data.expiresAt));
    sessionStorage.setItem('kid_user', JSON.stringify(data.user));
    // Stamped once, right here, so SessionWatcher can tell "a login happened
    // more recently than the one I'm using" apart from this login itself.
    const loginAt = new Date().toISOString();
    sessionStorage.setItem('kid_login_at', loginAt);
    // Also mirrored into localStorage (shared across every tab of this same
    // browser, unlike the sessionStorage stamp above), purely so another
    // already-open tab's SessionWatcher can recognize "that newer login was
    // just me, in a different tab" and not raise a false "signed in
    // elsewhere" security alarm over normal multi-tab use.
    try { localStorage.setItem('kid_last_login_marker', JSON.stringify({ userId: data.user.id, at: loginAt })); } catch { /* ignore (e.g. storage disabled) */ }
    setUser(data.user);
    return data.user;
  }

  // The access token Supabase issues only lasts 1 hour, refresh it well before
  // that on a timer so an actively-open session never actually hits the expiry
  // (api.js's own one-shot refresh-and-retry on a 401 is the fallback for
  // whatever this timer can't cover, e.g. the laptop was asleep through it).
  useEffect(() => {
    if (!user) return;
    const iv = setInterval(() => { if (getToken()) refreshAccessToken(); }, 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, [user]);

  /** Self-service parent/guardian registration. The account must verify its email before logging in. */
  async function signup({ firstName, lastName, email, password, contact }) {
    return api('/auth/signup', {
      method: 'POST',
      body: { first_name: firstName, last_name: lastName, email, password, contact }
    });
  }

  function logout() {
    sessionStorage.removeItem('kid_token');
    sessionStorage.removeItem('kid_refresh_token');
    sessionStorage.removeItem('kid_token_expires_at');
    sessionStorage.removeItem('kid_user');
    localStorage.removeItem('kid_admin_page');
    sessionStorage.removeItem('kid_login_at');
    // GAS scorecard drafts hold real clinical notes (parent observations,
    // remarks) about a specific child, autosaved to localStorage (one key per
    // client+discipline, see ScorecardWizardModal.jsx) so an interrupted
    // session isn't lost. localStorage outlives logout though, so on a shared
    // clinic computer the next person signing in could otherwise open that
    // same child's scorecard and see the previous therapist's unsubmitted
    // notes. Swept here so no draft survives past the session it was written in.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith('kid_gas_draft_')) localStorage.removeItem(key);
    }
    setUser(null);
  }

  /** Merge fields into the current user (e.g. privacy_consent_at after consenting). */
  function updateUser(patch) {
    setUser(u => {
      if (!u) return u;
      const next = { ...u, ...patch };
      sessionStorage.setItem('kid_user', JSON.stringify(next));
      return next;
    });
  }

  /** Forced first-login password change (or a general self-service change). Clears must_change_password on success. */
  async function changePassword(currentPassword, newPassword) {
    const data = await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    // Changing the password server-side revokes the token this request was
    // just authenticated with, every subsequent call would 401 until a fresh
    // login otherwise, so swap in the new one the server hands back here.
    if (data.token) sessionStorage.setItem('kid_token', data.token);
    if (data.refreshToken) sessionStorage.setItem('kid_refresh_token', data.refreshToken);
    if (data.expiresAt) sessionStorage.setItem('kid_token_expires_at', String(data.expiresAt));
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

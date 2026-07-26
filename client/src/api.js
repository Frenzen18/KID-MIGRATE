const BASE = '/api';

export const getToken = () => localStorage.getItem('kid_token');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The access token Supabase issues on login is only good for 1 hour, with no
// refresh anywhere in this app it used to just die mid-session, every portal,
// no warning, silently breaking every fetch until a full reload forced a
// re-login. One in-flight refresh at a time (concurrent 401s from several
// components at once all await the same promise instead of each hitting
// /auth/refresh separately and racing to rotate the same refresh token).
let refreshPromise = null;
export async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('kid_refresh_token');
  if (!refreshToken) return false;
  if (!refreshPromise) {
    refreshPromise = fetch(BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    }).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return false;
      localStorage.setItem('kid_token', data.token);
      localStorage.setItem('kid_refresh_token', data.refreshToken);
      localStorage.setItem('kid_token_expires_at', String(data.expiresAt));
      return true;
    }).catch(() => false).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

// A momentary Supabase/network hiccup, or the dev server restarting mid-request
// (node --watch reloads on every file save), shouldn't surface as a hard error
// right away, callers are already showing a loading spinner while this promise
// is pending, so quietly riding out a blip just keeps that spinner up a little
// longer instead of flashing an error toast. Five attempts spread over ~9s
// comfortably rides out a backend restart, which usually finishes in 1-3s.
const RETRY_DELAYS_MS = [400, 800, 1500, 2500, 4000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

// Shown whenever a failure carries no real message to display, either every
// retry above was exhausted, or the response wasn't from this app at all (a
// dev-proxy/dead-backend 500 with no body, whose default reason phrase would
// otherwise literally read "Internal Server Error").
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

export async function api(path, { method = 'GET', body } = {}) {
  let refreshedOnce = false;
  for (let attempt = 0; ; attempt++) {
    let res, data;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      data = await res.json().catch(() => ({}));
    } catch (networkErr) {
      // fetch() itself failed (dropped connection, backend process mid-restart,
      // DNS blip, ...), the request never reached the server at all, so retrying
      // can't double anything, safe regardless of method (GET or otherwise).
      if (attempt < MAX_ATTEMPTS - 1) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      const err = new Error(GENERIC_ERROR_MESSAGE);
      err.cause = networkErr;
      throw err;
    }

    if (res.ok) return data;

    // Every route in this app replies to an error with its own { error: '...' }
    // JSON, including the server's own catch-all, so a response that HAS that
    // shape means our Express app genuinely received and handled this request.
    // One with no such body (a dev-proxy/dead-backend response, or anything
    // else that never reached a real route handler) is exactly as safe to
    // retry as a straight network failure, whatever the method, nothing of
    // ours ever ran. A real app error on a mutation, though, only retries for
    // GET, it may have already partially applied server-side.
    const reachedApp = data && typeof data.error === 'string';

    // A 401 with a refresh token on hand gets exactly one silent refresh-and-
    // retry before giving up, this is what actually keeps a session alive past
    // the 1-hour access-token expiry during normal use (the periodic proactive
    // refresh in auth.jsx covers most of it, but not e.g. a laptop asleep
    // through the whole refresh window). If the refresh itself fails, falls
    // through to the normal error below, whatever called this sees the 401
    // and (for auth.jsx's own checks) logs out cleanly, same as before this existed.
    if (res.status === 401 && reachedApp && !refreshedOnce && localStorage.getItem('kid_refresh_token')) {
      refreshedOnce = true;
      if (await refreshAccessToken()) continue;
    }

    const safeToRetry = method === 'GET' || !reachedApp;
    if (res.status >= 500 && safeToRetry && attempt < MAX_ATTEMPTS - 1) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const err = new Error((reachedApp && data.error) || GENERIC_ERROR_MESSAGE);
    err.data = data; // expose extra fields like needsVerification
    err.status = res.status; // lets callers tell a 409 conflict apart from a plain 400/500
    throw err;
  }
}

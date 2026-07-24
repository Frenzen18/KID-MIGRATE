const BASE = '/api';

export const getToken = () => localStorage.getItem('kid_token');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A momentary Supabase/network hiccup shouldn't surface as a hard error right
// away, callers are already showing a loading spinner while this promise is
// pending, so quietly riding out a blip just keeps that spinner up a little
// longer instead of flashing an error toast. Only GET is retried, a POST/PUT/
// DELETE that already reached the server shouldn't be replayed blind.
const RETRY_DELAYS_MS = [400, 900, 1500];

export async function api(path, { method = 'GET', body } = {}) {
  const maxAttempts = method === 'GET' ? RETRY_DELAYS_MS.length + 1 : 1;

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
      // fetch() itself failed (dropped connection, DNS blip, ...), the request
      // never got a response at all, worth a quiet retry same as a 5xx below.
      if (attempt < maxAttempts - 1) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      throw networkErr;
    }

    if (res.ok) return data;

    // A real response came back, the server is up and explicitly rejected this
    // request (bad input, auth, not found, ...), retrying won't change that.
    // Only a 5xx, the server itself hit a transient problem, is worth retrying.
    if (res.status >= 500 && attempt < maxAttempts - 1) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const err = new Error(data.error || res.statusText || 'Request failed');
    err.data = data; // expose extra fields like needsVerification
    err.status = res.status; // lets callers tell a 409 conflict apart from a plain 400/500
    throw err;
  }
}

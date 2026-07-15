/**
 * TEMP verification (safe to delete): smoke-tests the shift-driven booking
 * availability. Creates a throwaway admin + two therapists (Fren & Geoff),
 * checks GET /api/shifts and GET /api/reservations/slots, and, if the
 * shifts table exists (migration_shifts.sql applied), sets Fren 8–12 and
 * Geoff 7–13 and verifies the slot capacities match the scenario.
 * Cleans up everything afterward.  Run with the API on :4001.
 */
import { db } from '../supabase.js';
import { nextUserCode } from '../usercode.js';

const API = 'http://localhost:4001/api';
const PASS = 'Verify1234';
const EMAILS = {
  admin: 'cc.verify.admin@example.com',
  fren: 'cc.verify.fren@example.com',
  geoff: 'cc.verify.geoff@example.com'
};

const req = async (method, path, body, token) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

async function makeUser(email, full_name, role) {
  const { data, error } = await db.auth.admin.createUser({
    email, password: PASS, email_confirm: true, user_metadata: { full_name, role },
    app_metadata: { role } // authoritative for authorization, see middleware/auth.js
  });
  if (error) throw new Error(email + ': ' + error.message);
  await db.from('profiles').insert({
    id: data.user.id, user_code: await nextUserCode(), email, full_name,
    first_name: full_name.split(' ')[0], last_name: full_name.split(' ')[1] || '', role, active: true
  });
  return data.user.id;
}

async function cleanup() {
  for (const email of Object.values(EMAILS)) {
    const { data: prof } = await db.from('profiles').select('id').ilike('email', email).maybeSingle();
    let id = prof?.id;
    if (!id) {
      const { data: page } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      id = page?.users?.find(x => (x.email || '').toLowerCase() === email)?.id;
    }
    if (id) {
      await db.from('shifts').delete().eq('therapist_id', id).then(() => {}, () => {});
      await db.from('profiles').delete().eq('id', id);
      await db.auth.admin.deleteUser(id).catch(() => {});
    }
  }
}

const summarize = slots => slots.map(s => `${s.time_slot}=${s.available}/${s.capacity}`).join('  ');

try {
  await cleanup();

  await makeUser(EMAILS.admin, 'CC VerifyAdmin', 'admin');
  const frenId = await makeUser(EMAILS.fren, 'Fren Verifier', 'ot');
  const geoffId = await makeUser(EMAILS.geoff, 'Geoff Verifier', 'speech');

  const { data: login } = await req('POST', '/auth/login', { email: EMAILS.admin, password: PASS, portal: 'admin' });
  const token = login.token;

  const shifts = await req('GET', '/shifts', null, token);
  console.log('1. GET /shifts:', shifts.status, JSON.stringify(shifts.data.map(s => `${s.name} ${s.start_hour}-${s.end_hour}`)));

  const date = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10); // next week
  let slots = await req('GET', '/reservations/slots?date=' + date, null, token);
  console.log('2. Default slots (both 8-17):', summarize(slots.data.filter(s => s.therapists.some(n => n.includes('Verifier')))?.length ? slots.data : slots.data));

  // Scenario: Fren 8–12, Geoff 7–13 (needs the shifts table from migration_shifts.sql)
  const setFren = await req('PUT', '/shifts/' + frenId, { start_hour: 8, end_hour: 12 }, token);
  const setGeoff = await req('PUT', '/shifts/' + geoffId, { start_hour: 7, end_hour: 13 }, token);
  console.log('3. Set Fren 8-12:', setFren.status, setFren.data.error || 'OK', '| Geoff 7-13:', setGeoff.status, setGeoff.data.error || 'OK');

  if (setFren.status === 200 && setGeoff.status === 200) {
    slots = await req('GET', '/reservations/slots?date=' + date, null, token);
    console.log('4. Scenario slots:', summarize(slots.data));

    // Book 9 AM twice (should auto-assign Fren & Geoff), third must fail.
    const { data: client } = await db.from('clients').select('id, full_name').limit(1).single();
    if (client) {
      const b1 = await req('POST', '/reservations', { date, time_slot: '9:00 AM', client_id: client.id }, token);
      const b2 = await req('POST', '/reservations', { date, time_slot: '9:00 AM', client_id: client.id }, token);
      const b3 = await req('POST', '/reservations', { date, time_slot: '9:00 AM', client_id: client.id }, token);
      console.log('5. Book 9AM #1:', b1.status, b1.data.therapist_name || b1.data.error);
      console.log('   Book 9AM #2:', b2.status, b2.data.therapist_name || b2.data.error);
      console.log('   Book 9AM #3 (should fail):', b3.status, b3.data.error || 'UNEXPECTED SUCCESS');
      const b4 = await req('POST', '/reservations', { date, time_slot: '7:00 AM', client_id: client.id }, token);
      console.log('6. Book 7AM (only Geoff on shift):', b4.status, b4.data.therapist_name || b4.data.error);
      // cleanup test bookings
      for (const b of [b1, b2, b4]) if (b.data?.id) await db.from('reservations').delete().eq('id', b.data.id);
    } else {
      console.log('5-6. Skipped booking test, no clients in DB.');
    }

    // 7. Availability matrix: give Fren a day off on the test date's weekday →
    //    the 8–12 slots should drop from 2 to 1 available.
    const idx = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0..Sun=6
    if (idx <= 5) {
      const wd = [true, true, true, true, true, true];
      wd[idx] = false;
      const off = await req('PUT', '/shifts/' + frenId, { work_days: wd }, token);
      slots = await req('GET', '/reservations/slots?date=' + date, null, token);
      console.log('7. Fren day-off on that weekday:', off.status, off.data.error || 'OK', '→', summarize(slots.data));
    }
  } else {
    console.log('4-6. Skipped scenario, run supabase/migration_shifts.sql first, then re-run this script.');
  }
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  await cleanup();
  console.log('Cleaned up test accounts.');
}

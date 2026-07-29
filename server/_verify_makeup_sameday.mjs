import { db, authClient } from './supabase.js';

const BASE = 'http://localhost:4000/api';
let failed = false;
function check(name, cond, extra) {
  if (cond) console.log('OK   ', name);
  else { failed = true; console.log('FAIL ', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function mintToken(email) {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const { data: verified, error: verr } = await authClient.auth.verifyOtp({
    token_hash: data.properties.hashed_token, type: 'magiclink'
  });
  if (verr) throw verr;
  return verified.session.access_token;
}

async function api(token, path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

function nextTuesday(weeksAhead) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((2 - d.getUTCDay() + 7) % 7 || 7) + weeksAhead * 7);
  return d.toISOString().slice(0, 10);
}

const cleanup = { clientId: null, scheduleIds: [], reservationIds: [] };

try {
  const { data: admin } = await db.from('profiles').select('email').eq('role', 'admin').limit(1).single();
  const token = await mintToken(admin.email);

  const tuesday = nextTuesday(13);
  console.log('Test Tuesday:', tuesday);

  const { data: client, error: cErr } = await db.from('clients').insert({
    client_code: 'ZZTEST-SAMEDAY-' + Date.now(), full_name: 'ZZTEST SameDayMakeup',
    first_name: 'ZZTEST', last_name: 'SameDayMakeup', dob: '2019-01-01', gender: 'Male',
    guardian_name: 'ZZTEST Guardian', guardian_contact: '09171234567', therapy_type: 'OT', status: 'active'
  }).select().single();
  if (cErr) throw cErr;
  cleanup.clientId = client.id;

  const { data: sch1, error: s1Err } = await db.from('recurring_schedules').insert({
    client_id: client.id, discipline: 'OT', day_of_week: 2, time_slot: '9:00 AM', therapist_name: 'Rem Gan', status: 'active'
  }).select().single();
  if (s1Err) throw s1Err;
  cleanup.scheduleIds.push(sch1.id);
  await db.from('clients').update({ assigned_ot_therapist_name: 'Rem Gan' }).eq('id', client.id);

  // Book the client's regular fixed-schedule session for this Tuesday first.
  const regular = await api(token, '/reservations', {
    method: 'POST',
    body: { client_id: client.id, date: tuesday, time_slot: '9:00 AM', session_type: 'Occupational Therapy', payment_amount: 1400 }
  });
  check('regular fixed-slot booking succeeds', regular.status === 201, regular.body);
  if (regular.body?.id) cleanup.reservationIds.push(regular.body.id);

  // Now try a make-up session with the SAME therapist, SAME day, different
  // time (2 PM) -- this used to be rejected by the "one booking per day" rule.
  const makeup = await api(token, '/reservations', {
    method: 'POST',
    body: {
      client_id: client.id, date: tuesday, time_slot: '2:00 PM', session_type: 'Occupational Therapy',
      therapist_name: 'Rem Gan', payment_amount: 1400, is_makeup: true
    }
  });
  check('make-up on the SAME day as an existing booking now succeeds', makeup.status === 201, makeup.body);
  check('make-up reservation is_makeup true', makeup.body?.is_makeup === true, makeup.body);
  if (makeup.body?.id) cleanup.reservationIds.push(makeup.body.id);

  // Exact-time double-booking must still be rejected even for a make-up.
  const exactClash = await api(token, '/reservations', {
    method: 'POST',
    body: {
      client_id: client.id, date: tuesday, time_slot: '2:00 PM', session_type: 'Occupational Therapy',
      therapist_name: 'Rem Gan', payment_amount: 1400, is_makeup: true
    }
  });
  check('a second make-up at the SAME exact time is still rejected', exactClash.status === 409, exactClash.body);

  console.log(failed ? '\n*** SOME CHECKS FAILED ***' : '\nAll checks passed.');
} catch (e) {
  failed = true;
  console.error('Script error:', e);
} finally {
  for (const id of cleanup.reservationIds) await db.from('reservations').delete().eq('id', id);
  for (const id of cleanup.scheduleIds) await db.from('recurring_schedules').delete().eq('id', id);
  if (cleanup.clientId) {
    await db.from('payments').delete().eq('client_id', cleanup.clientId);
    await db.from('clients').delete().eq('id', cleanup.clientId);
  }
  console.log('Cleaned up test data.');
  process.exit(failed ? 1 : 0);
}

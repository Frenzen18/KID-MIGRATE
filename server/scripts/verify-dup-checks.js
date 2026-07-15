/**
 * TEMP verification (safe to delete): exercises the duplicate/validation
 * error handling on POST /api/users. Creates throwaway accounts, tries all
 * the invalid inputs, prints each server response, then cleans up.
 * Run against the updated server:  PORT=4001 node index.js
 */
import { db } from '../supabase.js';
import { nextUserCode } from '../usercode.js';

const API = 'http://localhost:4001/api';
const ADMIN_EMAIL = 'cc.verify.admin@example.com';
const USER1_EMAIL = 'cc.verify.one@example.com';
const USER2_EMAIL = 'cc.verify.two@example.com';
const PASS = 'Verify1234';

const post = async (path, body, token) => {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

async function cleanup() {
  for (const email of [ADMIN_EMAIL, USER1_EMAIL, USER2_EMAIL]) {
    const { data: prof } = await db.from('profiles').select('id').ilike('email', email).maybeSingle();
    if (prof) {
      await db.from('profiles').delete().eq('id', prof.id);
      await db.auth.admin.deleteUser(prof.id).catch(() => {});
    } else {
      const { data: page } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const u = page?.users?.find(x => (x.email || '').toLowerCase() === email);
      if (u) await db.auth.admin.deleteUser(u.id).catch(() => {});
    }
  }
}

const show = (label, r) => console.log(`${label}: ${r.status}, ${r.data.error || JSON.stringify(r.data)}`);

try {
  await cleanup();

  // throwaway admin session
  const { data: adm, error: admErr } = await db.auth.admin.createUser({
    email: ADMIN_EMAIL, password: PASS, email_confirm: true,
    user_metadata: { full_name: 'CC Verify Admin', role: 'admin' }
  });
  if (admErr) throw new Error(admErr.message);
  await db.from('profiles').insert({
    id: adm.user.id, user_code: await nextUserCode(), email: ADMIN_EMAIL,
    first_name: 'CC', last_name: 'Verify Admin', full_name: 'CC Verify Admin', role: 'admin', active: true
  });
  const { data: login } = await post('/auth/login', { email: ADMIN_EMAIL, password: PASS, portal: 'admin' });
  const token = login.token;

  // baseline user (with phone, 09-format on purpose)
  const base = { email: USER1_EMAIL, password: PASS, first_name: 'Casey', last_name: 'Verify', role: 'staff', contact: '09991234567' };
  const r0 = await post('/users', base, token);
  show('CREATE baseline (09-format phone)', r0);
  const { data: stored } = await db.from('profiles').select('contact').ilike('email', USER1_EMAIL).single();
  console.log('   phone stored in DB as:', stored?.contact);

  show('DUPLICATE email     ', await post('/users', { ...base, first_name: 'Other', last_name: 'Person', contact: '' }, token));
  show('DUPLICATE name      ', await post('/users', { ...base, email: USER2_EMAIL, contact: '' }, token));
  show('DUPLICATE phone     ', await post('/users', { email: USER2_EMAIL, password: PASS, first_name: 'Diff', last_name: 'Name', role: 'staff', contact: '+639991234567' }, token));
  show('INVALID email       ', await post('/users', { email: 'not-an-email', password: PASS, first_name: 'X', last_name: 'Y', role: 'staff' }, token));
  show('INVALID phone       ', await post('/users', { email: USER2_EMAIL, password: PASS, first_name: 'X', last_name: 'Y2', role: 'staff', contact: '12345' }, token));
  show('WEAK password       ', await post('/users', { email: USER2_EMAIL, password: 'abc', first_name: 'X', last_name: 'Y3', role: 'staff' }, token));
  show('VALID second user   ', await post('/users', { email: USER2_EMAIL, password: PASS, first_name: 'Drew', last_name: 'Verify', role: 'ot', contact: '' }, token));
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  await cleanup();
  console.log('Cleaned up all test accounts.');
}

/**
 * TEMP verification script (safe to delete): proves that creating a user
 * through POST /api/users (what the User Management "Add User" button calls)
 * lands in Supabase with a KID-YYYY-NNNN ID and that the new user can log in.
 * Creates a throwaway admin + test user, then deletes both.
 */
import { db } from '../supabase.js';
import { nextUserCode } from '../usercode.js';

const API = 'http://localhost:4000/api';
const ADMIN_EMAIL = 'cc.verify.admin@example.com';
const TEST_EMAIL = 'cc.verify.staff@example.com';
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
  for (const email of [ADMIN_EMAIL, TEST_EMAIL]) {
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

try {
  await cleanup(); // in case of a previous half-run

  // 1) health
  const health = await fetch(API + '/health').then(r => r.json());
  console.log('1. API health:', JSON.stringify(health));

  // 2) throwaway admin (directly via service role, like seed.js does)
  const { data: adm, error: admErr } = await db.auth.admin.createUser({
    email: ADMIN_EMAIL, password: PASS, email_confirm: true,
    user_metadata: { full_name: 'CC Verify Admin', role: 'admin' }
  });
  if (admErr) throw new Error('create temp admin: ' + admErr.message);
  await db.from('profiles').insert({
    id: adm.user.id, user_code: await nextUserCode(), email: ADMIN_EMAIL,
    first_name: 'CC', last_name: 'Verify Admin', full_name: 'CC Verify Admin', role: 'admin', active: true
  });

  // 3) login as admin (same call the admin login page makes)
  const login = await post('/auth/login', { email: ADMIN_EMAIL, password: PASS, portal: 'admin' });
  console.log('2. Admin login:', login.status === 200 ? 'OK' : JSON.stringify(login));
  const token = login.data.token;

  // 4) create a user through the same endpoint the UI uses
  const created = await post('/users', {
    email: TEST_EMAIL, password: PASS, first_name: 'Casey', last_name: 'Verify', role: 'staff', contact: ''
  }, token);
  console.log('3. POST /api/users →', created.status, JSON.stringify(created.data));

  // 5) confirm it is really in the database
  const { data: row } = await db.from('profiles').select('user_code, email, full_name, role, active').ilike('email', TEST_EMAIL).single();
  console.log('4. Row in Supabase profiles table:', JSON.stringify(row));

  // 6) confirm the new user can log in to the system
  const staffLogin = await post('/auth/login', { email: TEST_EMAIL, password: PASS });
  console.log('5. New user login:', staffLogin.status === 200
    ? 'OK, role=' + staffLogin.data.user.role + ', name=' + staffLogin.data.user.name
    : JSON.stringify(staffLogin));
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  await cleanup();
  console.log('6. Test accounts cleaned up.');
}

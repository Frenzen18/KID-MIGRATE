/**
 * Seed script, creates 4 demo accounts (one per role) and ports the
 * mockup data (clients, session notes with qualitative remarks, bookings,
 * CMS posts, payments, notifications) into Supabase.
 *
 * Run AFTER schema.sql has been applied:  npm run seed
 * Safe to re-run: clears app tables and re-creates demo users.
 */
import { db } from '../supabase.js';

const USERS = [
  { email: 'admin@kidclinic.ph',  password: 'admin123',  full_name: 'Dr. Ana Reyes', role: 'admin' },
  { email: 'staff@kidclinic.ph',  password: 'staff123',   full_name: 'Lara Cruz',     role: 'staff' },
  { email: 'ot@kidclinic.ph',     password: 'ot123456',   full_name: 'Maria Santos',  role: 'ot' },
  { email: 'speech@kidclinic.ph', password: 'speech123',  full_name: 'Jose Reyes',    role: 'speech' },
  { email: 'parent@kidclinic.ph', password: 'parent123',  full_name: 'Maria Lim',     role: 'parent' },
];

const iso = d => d.toISOString().slice(0, 10);
const daysFromNow = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const monthsAgo = (n, day = 26) => { const d = new Date(); d.setMonth(d.getMonth() - n); d.setDate(day); return iso(d); };

async function ensureUser(u) {
  // find existing by listing (small demo set), or create fresh
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 100 });
  const existing = list?.users?.find(x => x.email === u.email);
  if (existing) {
    await db.auth.admin.updateUserById(existing.id, {
      password: u.password, email_confirm: true,
      user_metadata: { full_name: u.full_name, role: u.role },
      app_metadata: { role: u.role } // authoritative for authorization, see middleware/auth.js
    });
    return existing.id;
  }
  const { data, error } = await db.auth.admin.createUser({
    email: u.email, password: u.password, email_confirm: true,
    user_metadata: { full_name: u.full_name, role: u.role },
    app_metadata: { role: u.role }
  });
  if (error) throw new Error('createUser ' + u.email + ': ' + error.message);
  return data.user.id;
}

async function main() {
  console.log('- clearing app tables…');
  for (const t of ['notifications','payments','announcements','cms_posts','attendance','session_notes','reservations','clients','profiles']) {
    const { error } = await db.from(t).delete().gte('created_at', '1970-01-01');
    if (error) throw new Error('clear ' + t + ': ' + error.message + ' (did you run schema.sql?)');
  }

  console.log('- creating demo accounts…');
  const ids = {};
  for (const u of USERS) {
    ids[u.role] = await ensureUser(u);
    await db.from('profiles').upsert({ id: ids[u.role], email: u.email, full_name: u.full_name, role: u.role, active: true });
    console.log('   ', u.role.padEnd(9), u.email, '/', u.password);
  }

  console.log('- clients…');
  const clientRows = [
    { client_code: 'CLI-0204', full_name: 'Jake Lim', dob: '2021-03-14', gender: 'Male', guardian_name: 'Maria Lim', guardian_contact: '+63 917 555 0102', parent_id: ids.parent, diagnosis: 'Autism Spectrum Disorder (Level 2)', therapy_type: 'OT', status: 'active', enrolled_at: '2025-01-08' },
    { client_code: 'CLI-0189', full_name: 'Sofia Ramos', dob: '2022-06-03', gender: 'Female', guardian_name: 'Carlos Ramos', guardian_contact: '+63 918 222 0455', diagnosis: 'Language Development Delay', therapy_type: 'Speech', status: 'active', enrolled_at: '2025-03-02' },
    { client_code: 'CLI-0156', full_name: 'Ana Torres', dob: '2019-09-19', gender: 'Female', guardian_name: 'Elena Torres', guardian_contact: '+63 912 888 0311', diagnosis: 'Sensory Processing Disorder', therapy_type: 'OT', status: 'active', enrolled_at: '2024-11-05' },
    { client_code: 'CLI-0142', full_name: 'Miguel Dela Cruz', dob: '2019-12-01', gender: 'Male', guardian_name: 'Rosa Dela Cruz', guardian_contact: '+63 916 333 0788', diagnosis: 'ADHD with Fine Motor Delay', therapy_type: 'OT', status: 'on_hold', enrolled_at: '2024-08-14' },
    { client_code: 'CLI-0233', full_name: 'Noah Bautista', dob: '2020-04-02', gender: 'Male', guardian_name: 'Grace Bautista', guardian_contact: '+63 917 222 0913', diagnosis: 'Fine Motor Skills Delay', therapy_type: 'OT', status: 'active', enrolled_at: '2026-02-03' },
    { client_code: 'CLI-0211', full_name: 'Lia Mendoza', dob: '2023-02-22', gender: 'Female', guardian_name: 'James Mendoza', guardian_contact: '+63 915 444 0662', diagnosis: 'Expressive Language Delay', therapy_type: 'Speech', status: 'active', enrolled_at: '2026-06-10' },
    { client_code: 'CLI-0247', full_name: 'Zoe Villanueva', dob: '2021-08-30', gender: 'Female', guardian_name: 'Mark Villanueva', guardian_contact: '+63 918 777 0524', diagnosis: 'Speech Sound Disorder', therapy_type: 'Speech', status: 'recovered', enrolled_at: '2025-04-21' },
    { client_code: 'CLI-0260', full_name: 'Caleb Ocampo', dob: '2018-01-12', gender: 'Male', guardian_name: 'Joy Ocampo', guardian_contact: '+63 915 666 0347', diagnosis: 'Sensory Processing Disorder', therapy_type: 'OT', status: 'discontinued', enrolled_at: '2025-05-09' },
  ];
  const { data: clients, error: cErr } = await db.from('clients').insert(clientRows).select();
  if (cErr) throw new Error('clients: ' + cErr.message);
  const C = Object.fromEntries(clients.map(c => [c.client_code, c.id]));

  console.log('- session notes (Jake Lim full 6-month series + others)…');
  const jake = C['CLI-0204'];
  const mk = (m, domain, score, remark, next_plan, tags) => ({
    client_id: jake, therapist_name: 'Maria Santos', domain,
    session_date: monthsAgo(m), score, remark, next_plan, tags
  });
  const notes = [
    mk(5, 'Fine Motor', 38, 'Baseline: needs hand-over-hand support for grasping. Limited grip endurance.', 'Introduce resistive putty exercises.', ['Low Energy / Fatigue','Repetitive Behavior']),
    mk(4, 'Fine Motor', 45, 'Improved pincer grasp; still fatigues quickly after 10 minutes.', 'Increase task duration by 2-min increments.', ['Improved Grip','Goal-Directed Behavior']),
    mk(3, 'Fine Motor', 52, 'Can stack 8 blocks independently. 15-minute focus without redirection.', 'Begin scissor readiness activities.', ['Improved Grip','Cooperative','Focused']),
    mk(2, 'Fine Motor', 58, 'Scissor practice at 60% accuracy on straight cuts. Requested more paper verbally.', 'Progress to curved-line cutting.', ['Verbal Initiation','Cooperative']),
    mk(1, 'Fine Motor', 66, 'Cuts along straight lines with minimal cues. Better shoulder stability.', 'Introduce writing pre-strokes.', ['Focused','Goal-Directed Behavior']),
    mk(0, 'Fine Motor', 72, 'Improved grip strength; writes first name legibly with standard grip.', 'Progress to weighted utensil exercises.', ['Improved Grip','Cooperative','Focused']),
    mk(5, 'Speech & Language', 30, 'Baseline: 2-word utterances, ~15 word vocabulary. Mostly points.', 'Begin picture exchange routine.', ['Low Energy / Fatigue']),
    mk(4, 'Speech & Language', 34, 'New words emerging; imitates sounds readily during play.', 'Expand to 3-word phrases using modeling.', ['Verbal Initiation']),
    mk(3, 'Speech & Language', 41, 'Uses 3-word phrases with prompting. Labeled 5 new objects.', 'Target unprompted 3-word requests.', ['Verbal Initiation','Cooperative']),
    mk(2, 'Speech & Language', 47, 'Requests items verbally without prompt in structured activities.', 'Generalize requesting to snack transitions.', ['Verbal Initiation','Focused']),
    mk(1, 'Speech & Language', 52, 'Answers simple wh- questions consistently. 80+ word vocabulary.', 'Introduce narrative retelling.', ['Cooperative','Focused']),
    mk(0, 'Speech & Language', 58, 'Holds short conversations with familiar adults. Initiated topic with peer twice.', 'Expand conversational turns.', ['Verbal Initiation','Engages Peer Interaction']),
    mk(5, 'Social & Behavioral', 25, 'Baseline: parallel play only, avoids eye contact.', 'Build brief joint attention with preferred toys.', ['Easily Distracted','Repetitive Behavior']),
    mk(4, 'Social & Behavioral', 29, 'Brief eye contact during preferred activities.', 'Introduce turn-taking with one toy.', ['Focused']),
    mk(3, 'Social & Behavioral', 36, 'Takes turns with therapist support; 2-step cooperative game done.', 'Introduce peer partner for turn-taking.', ['Cooperative','Engages Peer Interaction']),
    mk(2, 'Social & Behavioral', 40, 'Initiated peer interaction twice. Waved goodbye independently.', 'Facilitate 5-minute peer play.', ['Engages Peer Interaction','Verbal Initiation']),
    mk(1, 'Social & Behavioral', 47, 'Joins group activity for 10 minutes; tolerates 3 peers.', 'Extend group participation to 15 minutes.', ['Engages Peer Interaction','Cooperative']),
    mk(0, 'Social & Behavioral', 53, 'Shares toys with minimal prompting. Sought peer to share snack.', 'Target conflict-resolution scripts.', ['Cooperative','Engages Peer Interaction','Goal-Directed Behavior']),
    mk(5, 'Cognitive', 42, 'Baseline: matches identical objects only; ~4 minute attention.', 'Begin sorting by color.', ['Low Energy / Fatigue','Easily Distracted']),
    mk(4, 'Cognitive', 46, 'Sorts by color and shape; attention up to 8 minutes.', 'Introduce 4-piece puzzles.', ['Focused','Goal-Directed Behavior']),
    mk(3, 'Cognitive', 50, 'Completes 6-piece puzzles independently.', 'Introduce 2-step directions.', ['Focused','Cooperative']),
    mk(2, 'Cognitive', 57, 'Follows 2-step instructions reliably; says "Done!" on completion.', 'Introduce 3-step routines.', ['Focused','Verbal Initiation']),
    mk(1, 'Cognitive', 63, 'Counts to 10 with 1:1 correspondence.', 'Introduce simple pattern completion.', ['Goal-Directed Behavior','Focused']),
    mk(0, 'Cognitive', 69, 'Sustains attention 15 minutes; completes worksheets with minimal prompting.', 'Introduce pre-academic readiness tasks.', ['Focused','Goal-Directed Behavior','Cooperative']),
  ];
  // lighter series for two more clients so lists/brackets have data
  const addSeries = (code, domain, tName, scores) => scores.forEach((s, i) => notes.push({
    client_id: C[code], therapist_name: tName, domain,
    session_date: monthsAgo(scores.length - 1 - i), score: s,
    remark: null, next_plan: null, tags: []
  }));
  addSeries('CLI-0189', 'Speech & Language', 'Jose Reyes', [28, 35, 42, 48, 53, 54]);
  addSeries('CLI-0156', 'Fine Motor', 'Maria Santos', [55, 62, 68, 74, 80, 85]);
  addSeries('CLI-0142', 'Fine Motor', 'Tessa Mendoza', [30, 34, 38, 41, 40, 42]);
  addSeries('CLI-0233', 'Fine Motor', 'Tessa Mendoza', [22, 31, 40, 48, 55]);
  const { error: nErr } = await db.from('session_notes').insert(notes);
  if (nErr) throw new Error('session_notes: ' + nErr.message);

  console.log('- attendance…');
  const att = [];
  for (let m = 5; m >= 0; m--) {
    for (let s = 0; s < 4; s++) {
      const d = new Date(); d.setMonth(d.getMonth() - m); d.setDate(3 + s * 7);
      att.push({ client_id: jake, session_date: iso(d), attended: !(m === 4 && s === 3) && !(m === 1 && s === 2) });
    }
  }
  await db.from('attendance').insert(att);

  console.log('- reservations…');
  await db.from('reservations').insert([
    { client_id: C['CLI-0204'], therapist_name: 'Maria Santos', date: daysFromNow(1), time_slot: '9:00 AM', session_type: 'Occupational Therapy', room: 'Room 1', status: 'confirmed', channel: 'admin', created_by: ids.admin },
    { client_id: C['CLI-0189'], therapist_name: 'Jose Reyes', date: daysFromNow(1), time_slot: '2:00 PM', session_type: 'Speech Therapy', duration_min: 45, room: 'Room 2', status: 'confirmed', channel: 'staff', created_by: ids.staff },
    { client_id: C['CLI-0156'], therapist_name: 'Tessa Mendoza', date: daysFromNow(2), time_slot: '10:00 AM', session_type: 'Occupational Therapy', room: 'Room 3', status: 'confirmed', channel: 'admin', created_by: ids.admin },
    { client_id: C['CLI-0211'], date: daysFromNow(3), time_slot: '11:00 AM', session_type: 'Speech Therapy', status: 'pending', channel: 'parent-portal', created_by: ids.parent },
    { client_id: C['CLI-0204'], date: daysFromNow(4), time_slot: '8:00 AM', session_type: 'Occupational Therapy', status: 'pending', channel: 'parent-portal', created_by: ids.parent },
  ]);

  console.log('- CMS posts + announcement…');
  await db.from('cms_posts').insert([
    { title: 'New Speech Therapy Program Launched', body: 'We are excited to announce an expanded speech therapy program with specialized sessions for early language development in toddlers and young children aged 2–8.', category: 'Programs', status: 'published', published_at: monthsAgo(1, 22) + 'T09:00:00Z' },
    { title: 'KID Clinic Wins Community Health Award', body: 'Bloomsdale Therapy Center has been recognized for its outstanding contribution to pediatric occupational and speech therapy in Imus, Cavite.', category: 'Awards', status: 'published', published_at: monthsAgo(1, 15) + 'T09:00:00Z' },
    { title: 'Summer Therapy Camp: Registration Open', body: 'Sensory integration activities, individual sessions, and parent workshops every Saturday. Early bird registration now open for ages 3–12.', category: 'Events', status: 'draft' },
  ]);
  await db.from('announcements').insert([
    { title: 'Summer Therapy Camp', body: 'Summer Therapy Camp, early bird registration is now open for OT and Speech sessions, ages 3–12. Limited slots available!', starts_on: monthsAgo(1, 1), status: 'published' },
  ]);

  console.log('- payments…');
  await db.from('payments').insert([
    { client_id: C['CLI-0204'], amount: 1400, method: 'GCash', reference: 'GCX-0042', status: 'paid', invoice_no: 'INV-0001', sealed: true, paid_at: new Date().toISOString() },
    { client_id: C['CLI-0189'], amount: 1200, method: 'Card', reference: 'CCX-0031', status: 'paid', invoice_no: 'INV-0002', sealed: true, paid_at: new Date().toISOString() },
    { client_id: C['CLI-0156'], amount: 2800, method: 'Bank Transfer', status: 'pending', invoice_no: 'INV-0003' },
    { client_id: C['CLI-0142'], amount: 1400, method: 'Cash', status: 'overdue', invoice_no: 'INV-0004' },
  ]);

  console.log('- notifications…');
  await db.from('notifications').insert([
    { title: '2 pending parent bookings', body: 'Parent booking requests are awaiting approval.', icon: 'fa-calendar-check', target_role: 'admin' },
    { title: '2 pending parent bookings', body: 'Parent booking requests are awaiting approval.', icon: 'fa-calendar-check', target_role: 'staff' },
    { title: 'Payment overdue', body: 'Miguel Dela Cruz has an overdue balance of ₱1,400.', icon: 'fa-peso-sign', target_role: 'admin' },
    { title: 'Booking request received', body: 'Your session request is pending clinic approval.', icon: 'fa-hourglass-half', target_user: ids.parent },
  ]);

  console.log('\n✔ Seed complete. Demo accounts:');
  for (const u of USERS) console.log('   ' + u.role.padEnd(9) + ' ' + u.email + '  /  ' + u.password);
}

main().catch(e => { console.error('\n✖ Seed failed:', e.message); process.exit(1); });

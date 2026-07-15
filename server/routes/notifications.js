import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../lib/audit.js';
import { describeNotification, channelEnabled } from '../lib/notify.js';
import { sendSms } from '../sms.js';
import { notifyBalanceReminderNow, notifySessionReminderNow } from '../lib/reminders.js';

const router = Router();
router.use(requireAuth);

/** GET /api/notifications, targeted at my role or my user id; not-yet-due scheduled ones stay hidden */
router.get('/', async (req, res) => {
  const { data, error } = await db.from('notifications')
    .select('*')
    .or(`target_role.eq.${req.user.role},target_user.eq.${req.user.id}`)
    .or(`scheduled_for.is.null,scheduled_for.lte.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** PUT /api/notifications/:id/read */
router.put('/:id/read', async (req, res) => {
  const { data: existing } = await db.from('notifications').select('target_role, target_user').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Notification not found' });
  if (existing.target_role !== req.user.role && existing.target_user !== req.user.id) {
    return res.status(403).json({ error: 'Not your notification' });
  }
  const { data, error } = await db.from('notifications').update({ read: true }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** PUT /api/notifications/read-all, marks every notification visible to the current user as read */
router.put('/read-all', async (req, res) => {
  const { error } = await db.from('notifications')
    .update({ read: true })
    .or(`target_role.eq.${req.user.role},target_user.eq.${req.user.id}`)
    .or(`scheduled_for.is.null,scheduled_for.lte.${new Date().toISOString()}`)
    .eq('read', false);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/**
 * POST /api/notifications, create (staff-side roles only, a parent must
 * never be able to push notifications to other users).
 * `scheduled_for` (send later instead of immediately) is an admin-only
 * capability, staff/ot/speech requests always send immediately, even if
 * a scheduled_for value is sent, so this can't be bypassed from devtools.
 */
router.post('/', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title is required' });
  const scheduled_for = req.user.role === 'admin' && b.scheduled_for ? b.scheduled_for : null;
  const { data, error } = await db.from('notifications').insert({
    title: b.title, body: b.body || '', icon: b.icon || 'fa-bell',
    target_role: b.target_role || null, target_user: b.target_user || null,
    created_by: req.user.id, scheduled_for
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await logAudit({
    table_name: 'notifications', record_id: data.id, action: 'create',
    description: describeNotification(b.title, b.target_role, b.target_user) + (scheduled_for ? ` (scheduled for ${new Date(scheduled_for).toLocaleString()})` : ''),
    created_by: req.user.id
  });

  // SMS only fires for immediate sends, a "Schedule for Later" push defers
  // delivery, so texting the recipient right away would defeat the point.
  if (!scheduled_for && await channelEnabled('channel_sms')) {
    const smsText = b.title + (b.body ? ': ' + b.body : '') + ', KID Clinic';
    if (b.target_user) {
      const { data: recipient } = await db.from('profiles').select('contact').eq('id', b.target_user).maybeSingle();
      if (recipient?.contact) sendSms({ to: recipient.contact, message: smsText }).catch(e => console.error('Push SMS failed:', e.message));
    } else if (b.target_role) {
      const { data: recipients } = await db.from('profiles').select('contact').eq('role', b.target_role).eq('active', true);
      for (const r of recipients || []) {
        if (r.contact) sendSms({ to: r.contact, message: smsText }).catch(e => console.error('Push SMS failed:', e.message));
      }
    }
  }

  res.status(201).json(data);
});

/**
 * GET /api/notifications/sent, real dispatch history (12.3 "Recently Sent" +
 * 12.5 "Audit Logs"). ?mine=true scopes to the current user's own pushes;
 * otherwise every notification anyone has sent, newest first.
 */
router.get('/sent', requireRole('admin', 'staff'), async (req, res) => {
  let q = db.from('notifications')
    .select('*, creator:profiles!created_by(full_name), recipient:profiles!target_user(full_name)')
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(req.query.limit, 10) || 100, 500));
  if (req.query.mine === 'true') q = q.eq('created_by', req.user.id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** GET /api/notifications/settings, the 12.4 Configuration tab's saved state */
router.get('/settings', requireRole('admin', 'staff'), async (req, res) => {
  const { data, error } = await db.from('notification_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/** PUT /api/notifications/settings, persists the 12.4 Configuration tab */
router.put('/settings', requireRole('admin', 'staff'), async (req, res) => {
  const allowed = [
    'notify_booking_request', 'notify_payment_received', 'notify_scorecard_submitted', 'notify_reschedule_request',
    'notify_session_cancellation', 'notify_shift_reassignment', 'notify_session_change', 'notify_balance_reminder',
    'notify_session_reminder', 'cooldown_minutes', 'balance_reminder_frequency_days', 'session_reminder_lead_hours',
    'channel_in_app', 'channel_email', 'channel_sms'
  ];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  patch.updated_at = new Date().toISOString();
  patch.updated_by = req.user.id;

  const { data, error } = await db.from('notification_settings').update(patch).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * GET /api/notifications/reminders, real, derived operational reminders.
 * Admin/staff see clinic-wide overdue/pending balances, pending booking
 * requests, and sessions happening in the next 24 hours. An 'ot'/'speech'
 * therapist only sees their own upcoming sessions, billing and front-desk
 * booking reminders aren't their job. No separate table, these are
 * computed live from payments and reservations so they can never drift
 * from what's actually true.
 */
router.get('/reminders', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const isTherapist = req.user.role === 'ot' || req.user.role === 'speech';
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000); // PH time
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [{ data: overdue }, { data: pendingBookings }, { data: upcoming }] = await Promise.all([
    isTherapist ? { data: [] } : db.from('payments').select('*, clients(full_name, client_code)').in('status', ['pending', 'overdue']).order('created_at'),
    isTherapist ? { data: [] } : db.from('reservations').select('*, clients(full_name, client_code)').eq('status', 'pending').order('date'),
    (() => {
      let q = db.from('reservations').select('*, clients(full_name, client_code)').in('status', ['confirmed', 'rescheduled']).gte('date', todayStr).lte('date', tomorrow).order('date').order('time_slot');
      if (isTherapist) q = q.eq('therapist_name', req.user.name);
      return q;
    })()
  ]);

  const reminders = [];

  for (const p of overdue || []) {
    const days = Math.floor((now.getTime() - new Date(p.created_at).getTime()) / (24 * 60 * 60 * 1000));
    reminders.push({
      id: 'payment-' + p.id,
      record_id: p.id,
      type: 'Payment',
      typePill: 'pill-red',
      title: 'Outstanding balance, ' + (p.clients?.full_name || 'Unknown client'),
      sub: '₱' + Number(p.amount).toLocaleString() + ' unpaid' + (days > 0 ? ' since ' + days + ' day' + (days === 1 ? '' : 's') + ' ago' : ''),
      due: p.status === 'overdue' ? 'Overdue' : 'Pending',
      dueUrgent: p.status === 'overdue',
      priority: p.status === 'overdue' ? 'Urgent' : 'High',
      priorityPill: p.status === 'overdue' ? 'pill-red' : 'pill-amber',
      assignedTo: 'Billing',
      link: 'payments'
    });
  }

  for (const r of pendingBookings || []) {
    reminders.push({
      id: 'booking-' + r.id,
      record_id: r.id,
      type: 'Reservation',
      typePill: 'pill-blue',
      title: 'Booking request, ' + (r.clients?.full_name || 'Unknown client'),
      sub: (r.channel === 'parent-portal' ? 'Parent self-service' : 'Staff-entered') + ' · awaiting approval for ' + r.date + ' ' + r.time_slot,
      due: 'Today',
      dueUrgent: false,
      priority: 'High',
      priorityPill: 'pill-amber',
      assignedTo: 'Front Desk',
      link: 'reservations'
    });
  }

  for (const r of upcoming || []) {
    reminders.push({
      id: 'session-' + r.id,
      record_id: r.id,
      type: 'Session',
      typePill: 'pill-teal',
      title: 'Upcoming session, ' + (r.clients?.full_name || 'Unknown client'),
      sub: r.date + ' · ' + r.time_slot + (r.therapist_name ? ' with ' + r.therapist_name : '') + ' · ' + r.session_type,
      due: r.date === todayStr ? 'Today ' + r.time_slot : 'Tomorrow ' + r.time_slot,
      dueUrgent: false,
      priority: 'Normal',
      priorityPill: 'pill-blue',
      assignedTo: r.therapist_name || 'Unassigned',
      link: 'reservations'
    });
  }

  res.json(reminders);
});

/**
 * POST /api/notifications/reminders/notify, the 12.1 Reminders table's
 * "Notify" button. Payment/Session reminders message the actual guardian
 * (in-app + SMS, same wording as the automated sweep), there's no automated
 * frequency gate here since a staff member is explicitly asking for it now.
 * A pending booking Reservation has no parent action to notify them about
 * (they already submitted it); it just re-flags the request for admins.
 */
router.post('/reminders/notify', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  const { type, record_id, title, body } = req.body || {};
  if (!type || !record_id) return res.status(400).json({ error: 'type and record_id are required' });
  try {
    if (type === 'Payment') {
      await notifyBalanceReminderNow(record_id);
    } else if (type === 'Session') {
      await notifySessionReminderNow(record_id);
    } else {
      const { data, error } = await db.from('notifications').insert({
        title: title || 'Reminder', body: body || '', icon: 'fa-bell', target_role: 'admin', created_by: req.user.id
      }).select().single();
      if (error) throw new Error(error.message);
      await logAudit({
        table_name: 'notifications', record_id: data.id, action: 'create',
        description: describeNotification(title || 'Reminder', 'admin', null), created_by: req.user.id
      });
      if (await channelEnabled('channel_sms')) {
        const smsText = (title || 'Reminder') + (body ? ': ' + body : '') + ', KID Clinic';
        const { data: recipients } = await db.from('profiles').select('contact').eq('role', 'admin').eq('active', true);
        for (const r of recipients || []) {
          if (r.contact) sendSms({ to: r.contact, message: smsText }).catch(e => console.error('Reminder SMS failed:', e.message));
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;

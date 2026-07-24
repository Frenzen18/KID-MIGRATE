import { useState, useEffect } from 'react';
import { api } from '../../../api.js';

/* == page: notifications == */

/** "5 min ago" / "3 hrs ago" / "Jun 27" style relative timestamp for notification rows. */
function relativeTime(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return min + ' min ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hr ago' : ' hrs ago');
  const day = Math.floor(hr / 24);
  if (day < 7) return day + (day === 1 ? ' day ago' : ' days ago');
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
/** "Jul 3, 2026 8:14 AM" style absolute timestamp for the audit log. */
function fullDateTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function Notifications({ go, toast, openModal, role = 'admin' }) {
  // An 'ot'/'speech' therapist sees Reminders and their own Notifications
  // inbox, push-send and configuration stay clinic-wide, admin/staff-only.
  const isTherapist = role === 'ot' || role === 'speech';

  /* ── Tab switching ── */
  const NOTIF_TAB_KEYS = isTherapist ? ['reminders', 'inbox'] : ['reminders', 'inbox', 'push', 'config'];
  const notifTabStorageKey = 'kid_' + role + '_notifications_tab';
  const [tab, setTab] = useState(() => {
    const saved = localStorage.getItem(notifTabStorageKey);
    return NOTIF_TAB_KEYS.includes(saved) ? saved : 'reminders';
  });

  // The "By Role" target list, minus whichever role is doing the composing,
  // sending a role-broadcast to your own role is never what someone wants
  // here, "All Users" already covers the "everyone including me" case.
  const PUSH_ROLE_OPTIONS = [
    { value: 'admin', label: 'Administrators' },
    { value: 'staff', label: 'Staff' },
    { value: 'ot', label: 'Occupational Therapists' },
    { value: 'speech', label: 'Speech-Language Therapists' },
    { value: 'parent', label: 'Parents / Guardians' }
  ].filter(opt => opt.value !== role);

  /* ── Push trigger form state ── */
  const [pushTargetType, setPushTargetType] = useState('role');
  const [pushRole, setPushRole] = useState(PUSH_ROLE_OPTIONS[0]?.value || 'staff');
  const [pushUserId, setPushUserId] = useState('');
  const [pushTitle, setPushTitle] = useState('');
  const [pushBody, setPushBody] = useState('');
  const [pushSending, setPushSending] = useState(false);
  // Scheduling ("send later") is admin-only, staff is restricted to immediate send.
  const [pushSendMode, setPushSendMode] = useState('now');
  const [pushScheduleAt, setPushScheduleAt] = useState('');

  const [staffUsers, setStaffUsers] = useState([]);
  useEffect(() => {
    if (isTherapist) return;
    api('/users').then(data => setStaffUsers((data || []).filter(u => u.active !== false))).catch(() => setStaffUsers([]));
  }, []);

  /* ── 12.3 Recently Sent, real, persisted (survives refresh), scoped to what I sent ── */
  const [sentByMe, setSentByMe] = useState([]);
  const [sentLoading, setSentLoading] = useState(true);
  const fetchSentByMe = () => {
    setSentLoading(true);
    api('/notifications/sent?mine=true&limit=5')
      .then(data => setSentByMe(data || []))
      .catch(() => setSentByMe([]))
      .finally(() => setSentLoading(false));
  };
  useEffect(() => { if (!isTherapist) fetchSentByMe(); else setSentLoading(false); }, []);

  /* ── 12.4 Configuration, real, persisted settings ── */
  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  useEffect(() => {
    if (isTherapist) { setSettingsLoading(false); return; }
    api('/notifications/settings')
      .then(setSettings)
      .catch(() => toast('Failed to load notification settings', 'fa-triangle-exclamation'))
      .finally(() => setSettingsLoading(false));
  }, []);
  function toggleSetting(key) { setSettings(s => (s ? { ...s, [key]: !s[key] } : s)); }
  function setSettingField(key, value) { setSettings(s => (s ? { ...s, [key]: value } : s)); }
  async function saveSettings() {
    if (!settings) return;
    setSettingsSaving(true);
    try {
      const updated = await api('/notifications/settings', { method: 'PUT', body: settings });
      setSettings(updated);
      toast('Notification configuration saved', 'fa-floppy-disk');
    } catch (e) {
      toast(e.message || 'Failed to save settings', 'fa-triangle-exclamation');
    } finally {
      setSettingsSaving(false);
    }
  }

  /* ── Real notification inbox (12.2), fetched from /api/notifications ── */
  const [inbox, setInbox] = useState([]);
  const [inboxLoading, setInboxLoading] = useState(true);

  const fetchInbox = () => {
    setInboxLoading(true);
    api('/notifications')
      .then(data => setInbox(data || []))
      .catch(() => setInbox([]))
      .finally(() => setInboxLoading(false));
  };
  useEffect(() => { fetchInbox(); }, []);

  /* Visiting this page is itself "reading" the inbox, mark everything read
     automatically instead of requiring a manual click per item, same
     behavior as the notification bell dropdown elsewhere in the app. */
  useEffect(() => {
    if (inboxLoading) return;
    if (!inbox.some(n => !n.read)) return;
    api('/notifications/read-all', { method: 'PUT' })
      .then(() => setInbox(list => list.map(n => ({ ...n, read: true }))))
      .catch(() => {});
  }, [inboxLoading]);

  async function markInboxRead(id) {
    try {
      await api('/notifications/' + id + '/read', { method: 'PUT' });
      setInbox(list => list.map(n => (n.id === id ? { ...n, read: true } : n)));
    } catch (e) {
      toast('Failed to mark as read', 'fa-triangle-exclamation');
    }
  }

  /* ── Real reminders (12.1), booking requests only, derived server-side from reservations ── */
  const [reminders, setReminders] = useState([]);
  const [remindersLoading, setRemindersLoading] = useState(true);
  const [dismissedReminders, setDismissedReminders] = useState(new Set());

  useEffect(() => {
    setRemindersLoading(true);
    api('/notifications/reminders')
      .then(data => setReminders(data || []))
      .catch(() => setReminders([]))
      .finally(() => setRemindersLoading(false));
  }, []);

  async function notifyReminder(r) {
    try {
      await api('/notifications/reminders/notify', {
        method: 'POST',
        body: { type: r.type, record_id: r.record_id, title: r.title, body: r.sub }
      });
      toast('Notification sent', 'fa-paper-plane');
    } catch (e) {
      toast(e.message || 'Failed to send notification', 'fa-triangle-exclamation');
    }
  }

  function dismissReminder(id) {
    setDismissedReminders(prev => new Set(prev).add(id));
  }

  const visibleReminders = reminders.filter(r => !dismissedReminders.has(r.id));

  function switchNotifTab(t) {
    setTab(t);
    localStorage.setItem(notifTabStorageKey, t);
  }

  async function sendPushNotif() {
    const title = pushTitle.trim();
    const body = pushBody.trim();
    if (!title || !body) { toast('Please fill in title and message', 'fa-triangle-exclamation'); return; }
    if (pushTargetType === 'specific' && !pushUserId) { toast('Please select a user', 'fa-triangle-exclamation'); return; }
    const scheduling = role === 'admin' && pushSendMode === 'later';
    if (scheduling && !pushScheduleAt) { toast('Pick a date and time to schedule for', 'fa-triangle-exclamation'); return; }
    if (scheduling && new Date(pushScheduleAt) <= new Date()) { toast('Scheduled time must be in the future', 'fa-triangle-exclamation'); return; }

    setPushSending(true);
    try {
      const targets = pushTargetType === 'role' ? [{ target_role: pushRole }]
        : pushTargetType === 'specific' ? [{ target_user: pushUserId }]
        : ['admin', 'staff', 'ot', 'speech', 'parent'].map(target_role => ({ target_role }));
      const scheduled_for = scheduling ? new Date(pushScheduleAt).toISOString() : undefined;

      await Promise.all(targets.map(t => api('/notifications', { method: 'POST', body: { title, body, scheduled_for, ...t } })));

      fetchSentByMe();
      toast(scheduling ? 'Notification scheduled!' : 'Notification sent successfully!', scheduling ? 'fa-clock' : 'fa-paper-plane');
      setPushTitle('');
      setPushBody('');
      setPushScheduleAt('');
      setPushSendMode('now');
    } catch (e) {
      toast('Failed to send notification: ' + (e.message || 'Unknown error'), 'fa-triangle-exclamation');
    } finally {
      setPushSending(false);
    }
  }

  function roleLabel(role) {
    return { admin: 'Administrators', staff: 'Staff', ot: 'Occupational Therapists', speech: 'Speech-Language Therapists', parent: 'Parents / Guardians' }[role] || role;
  }

  return (
    <div className="spa-page" id="spa-notifications">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 4px' }}>Notifications &amp; Reminders</h1>
        </div>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        <button className={'notif-tab' + (tab === 'reminders' ? ' active' : '')} onClick={() => switchNotifTab('reminders')}><i className="fa-solid fa-clock" style={{ marginRight: 6 }} />Reminders</button>
        <button className={'notif-tab' + (tab === 'inbox' ? ' active' : '')} onClick={() => switchNotifTab('inbox')}><i className="fa-solid fa-inbox" style={{ marginRight: 6 }} />Notifications</button>
        {!isTherapist && <button className={'notif-tab' + (tab === 'push' ? ' active' : '')} onClick={() => switchNotifTab('push')}><i className="fa-solid fa-paper-plane" style={{ marginRight: 6 }} />Push Trigger</button>}
        {!isTherapist && <button className={'notif-tab' + (tab === 'config' ? ' active' : '')} onClick={() => switchNotifTab('config')}><i className="fa-solid fa-sliders" style={{ marginRight: 6 }} />Configuration</button>}
      </div>

      {/* ═══════ 12.1 REMINDERS TABLE ═══════ */}
      <div id="tab-reminders" style={{ display: tab === 'reminders' ? 'block' : 'none' }}>
        <div style={{ marginBottom: 24 }}>
          <div className="card" style={{ padding: '22px 0 0' }}>
            <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9' }}>
              <div className="section-title">Reminders Table</div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" id="reminder-table">
                <thead><tr>
                  <th style={{ paddingLeft: 24 }}>Reminder</th>
                  <th>Type</th>
                  <th>Due</th>
                  <th>Assigned To</th>
                  <th style={{ textAlign: 'right', paddingRight: 24 }}>Actions</th>
                </tr></thead>
                <tbody>
                  {remindersLoading ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: '#64748B', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading reminders…</td></tr>
                  ) : visibleReminders.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: '#94A3B8', fontSize: 13 }}><i className="fa-solid fa-circle-check" style={{ marginRight: 8, color: '#10B981' }} />Nothing needs attention right now.</td></tr>
                  ) : visibleReminders.map(r => (
                    <tr key={r.id}>
                      <td style={{ paddingLeft: 24 }}><div style={{ fontWeight: 600, color: '#0F172A' }}>{r.title}</div><div style={{ fontSize: 11.5, color: '#94A3B8' }}>{r.sub}</div></td>
                      <td><span className={'pill ' + r.typePill} style={{ fontSize: 10 }}>{r.type}</span></td>
                      <td style={{ fontSize: 12.5, fontWeight: 600, color: r.dueUrgent ? '#DC2626' : '#0F172A' }}>{r.due}</td>
                      <td style={{ fontSize: 12.5 }}>{r.assignedTo}</td>
                      <td style={{ textAlign: 'right', paddingRight: 24 }}>
                        <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                          {r.link && <a href="#" onClick={e => { e.preventDefault(); go(r.link); }} className="btn-edit" style={{ fontSize: 11, textDecoration: 'none' }}>Review</a>}
                          <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => notifyReminder(r)}>Notify</button>
                          <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => dismissReminder(r.id)}>Dismiss</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════ 12.2 NOTIFICATIONS INBOX ═══════ */}
      <div id="tab-inbox" style={{ display: tab === 'inbox' ? 'block' : 'none' }}>
        <div className="card" style={{ padding: '22px 0 0' }}>
          <div style={{ padding: '0 24px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div><div className="section-title">Notification Inbox</div><div className="section-sub">All system-generated notifications across event types</div></div>
          </div>
          <div style={{ padding: '8px 24px 0' }}>
            {inboxLoading ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: '#64748B', fontSize: 13 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading notifications…</div>
            ) : inbox.length === 0 ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: '#94A3B8', fontSize: 12.5 }}>No notifications yet.</div>
            ) : inbox.map((n, i) => (
              <div key={n.id} className={'notif-row' + (!n.read ? ' unread' : '')} style={i === inbox.length - 1 ? { borderBottom: 'none' } : undefined}>
                <div className="notif-icon" style={{ background: !n.read ? '#DBEAFE' : '#F1F5F9', color: !n.read ? '#2563EB' : '#94A3B8' }}><i className={'fa-solid ' + (n.icon || 'fa-bell')} /></div>
                {!n.read && <div className="unread-dot" />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: '#0F172A', fontSize: 13.5 }}>{n.title}</div>
                  {n.body && <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{n.body}</div>}
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{relativeTime(n.created_at)}</div>
                </div>
                {!n.read && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
                    <button className="btn-edit" style={{ fontSize: 11 }} onClick={() => markInboxRead(n.id)}>Mark read</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ padding: '14px 24px', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#64748B' }}>Showing {inbox.length} notification{inbox.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>

      {/* ═══════ 12.3 PUSH TRIGGER ═══════ */}
      <div id="tab-push" style={{ display: tab === 'push' ? 'block' : 'none' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
          <div className="card" style={{ padding: 24 }}>
            <div className="section-title" style={{ marginBottom: 4 }}>Manual Push Notification Trigger</div>
            <div className="section-sub" style={{ marginBottom: 20 }}>Send a push notification directly to a user role or specific account</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label className="form-label">Target Audience</label>
                <select className="form-select" id="push-target-type" value={pushTargetType} onChange={e => setPushTargetType(e.target.value)}>
                  <option value="role">By Role</option>
                  <option value="specific">Specific User</option>
                  <option value="all">All Users</option>
                </select>
              </div>
              <div id="push-role-wrap" style={{ display: pushTargetType === 'role' ? 'block' : 'none' }}>
                <label className="form-label">Role</label>
                <select className="form-select" value={pushRole} onChange={e => setPushRole(e.target.value)}>
                  {PUSH_ROLE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </div>
              <div id="push-user-wrap" style={{ display: pushTargetType === 'specific' ? 'block' : 'none' }}>
                <label className="form-label">Select User</label>
                <select className="form-select" value={pushUserId} onChange={e => setPushUserId(e.target.value)}>
                  <option value="">- Select a user -</option>
                  {staffUsers.map(u => <option key={u.id} value={u.id}>{u.full_name} ({roleLabel(u.role)})</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Notification Title</label>
                <input className="form-input" placeholder="e.g. Clinic Closure Notice" id="push-title" value={pushTitle} onChange={e => setPushTitle(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Message Body</label>
                <textarea className="form-input" style={{ height: 100, paddingTop: 10, resize: 'vertical' }} placeholder="Type the notification message here…" id="push-body" value={pushBody} onChange={e => setPushBody(e.target.value)} />
              </div>
              {role === 'admin' ? (
                <div>
                  <label className="form-label">Delivery</label>
                  <div style={{ display: 'flex', gap: 8, marginBottom: pushSendMode === 'later' ? 8 : 0 }}>
                    <button type="button" className={'gw-btn' + (pushSendMode === 'now' ? ' selected' : '')} onClick={() => setPushSendMode('now')}><i className="fa-solid fa-bolt" style={{ marginRight: 5 }} />Send Immediately</button>
                    <button type="button" className={'gw-btn' + (pushSendMode === 'later' ? ' selected' : '')} onClick={() => setPushSendMode('later')}><i className="fa-solid fa-clock" style={{ marginRight: 5 }} />Schedule for Later</button>
                  </div>
                  {pushSendMode === 'later' && (
                    <input className="form-input" type="datetime-local" value={pushScheduleAt} onChange={e => setPushScheduleAt(e.target.value)} min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} />
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: '#94A3B8' }}><i className="fa-solid fa-circle-info" style={{ marginRight: 5 }} />Staff can only send notifications immediately, scheduling is an admin-only capability.</div>
              )}
              <button className="btn-primary" disabled={pushSending} onClick={sendPushNotif}>
                <i className={'fa-solid ' + (pushSending ? 'fa-spinner fa-spin' : role === 'admin' && pushSendMode === 'later' ? 'fa-clock' : 'fa-paper-plane')} style={{ marginRight: 6 }} />
                {pushSending ? (role === 'admin' && pushSendMode === 'later' ? 'Scheduling…' : 'Sending…') : (role === 'admin' && pushSendMode === 'later' ? 'Schedule Notification' : 'Send Push Notification')}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 14 }}>Recently Sent</div>
              {sentLoading ? (
                <div style={{ padding: '8px 0', color: '#94A3B8', fontSize: 12.5 }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Loading…</div>
              ) : sentByMe.length === 0 ? (
                <div style={{ padding: '8px 0', color: '#94A3B8', fontSize: 12.5 }}>Nothing sent yet.</div>
              ) : sentByMe.map((p, i) => {
                const pending = p.scheduled_for && new Date(p.scheduled_for) > new Date();
                return (
                <div key={p.id} className="act-item" style={i === sentByMe.length - 1 ? { borderBottom: 'none' } : undefined}>
                  <div className="act-avatar" style={{ background: '#E0F2FE', color: '#0EA5E9' }}><i className={'fa-solid ' + (pending ? 'fa-clock' : 'fa-paper-plane')} style={{ fontSize: 13 }} /></div>
                  <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{p.title}</div><div className="act-meta">→ {p.target_role ? 'By role: ' + roleLabel(p.target_role) : (p.recipient?.full_name || 'Selected user')}</div><div className="act-meta">{pending ? 'Scheduled for ' + fullDateTime(p.scheduled_for) : relativeTime(p.created_at)}</div></div>
                  <span className={'pill ' + (pending ? 'pill-amber' : 'pill-green')} style={{ fontSize: 10 }}>{pending ? 'Scheduled' : 'Sent'}</span>
                </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ═══════ 12.4 CONFIGURATION ═══════ */}
      <div id="tab-config" style={{ display: tab === 'config' ? 'block' : 'none' }}>
        {settingsLoading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 8 }} />Loading configuration…</div>
        ) : !settings ? (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>Couldn't load notification settings.</div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16 }}>
          <div className="card" style={{ padding: 24 }}>
            <div className="section-title" style={{ marginBottom: 4 }}>Configure Push Notification Triggers</div>
            <div className="section-sub" style={{ marginBottom: 20 }}>Toggle which system events automatically trigger push notifications</div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Booking Reservation Request</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Notify admin when a parent submits a self-service booking</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_booking_request} onChange={() => toggleSetting('notify_booking_request')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Payment Received</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Notify on successful gateway payment confirmation</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_payment_received} onChange={() => toggleSetting('notify_payment_received')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Post-Session Scorecard Submitted</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Notify the parent when their therapist logs a new progress scorecard</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_scorecard_submitted} onChange={() => toggleSetting('notify_scorecard_submitted')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Reschedule Request</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Notify the parent when staff/admin reschedules one of their sessions to a new date or time</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_reschedule_request} onChange={() => toggleSetting('notify_reschedule_request')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Session Cancellation</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Alert when a parent or therapist cancels a booked session</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_session_cancellation} onChange={() => toggleSetting('notify_session_cancellation')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Shift Reassignment</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Notify affected staff when a shift conflict or reassignment occurs</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_shift_reassignment} onChange={() => toggleSetting('notify_shift_reassignment')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Therapy Session Change</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Notify the parent when their pending booking request is confirmed</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_session_change} onChange={() => toggleSetting('notify_session_change')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap">
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Outstanding Balance Reminder</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Auto-remind parents with unpaid balances past due date</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_balance_reminder} onChange={() => toggleSetting('notify_balance_reminder')} /><span className="toggle-slider" /></label>
            </div>
            <div className="toggle-wrap" style={{ borderBottom: 'none' }}>
              <div><div style={{ fontSize: 13.5, fontWeight: 600, color: '#0F172A' }}>Session Reminder</div><div style={{ fontSize: 12, color: '#94A3B8' }}>Auto-remind guardians ahead of an upcoming session (see lead time below)</div></div>
              <label className="toggle"><input type="checkbox" checked={settings.notify_session_reminder} onChange={() => toggleSetting('notify_session_reminder')} /><span className="toggle-slider" /></label>
            </div>
            <button className="btn-primary" style={{ width: '100%', marginTop: 18 }} disabled={settingsSaving} onClick={saveSettings}>
              {settingsSaving ? <><i className="fa-solid fa-spinner fa-spin" style={{ marginRight: 6 }} />Saving…</> : 'Save Configuration'}
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 14 }}>Cooldown Settings</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div><label className="form-label">Min. interval between same-type notifs</label>
                  <select className="form-select" value={settings.cooldown_minutes} onChange={e => setSettingField('cooldown_minutes', parseInt(e.target.value, 10))}>
                    <option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={180}>3 hours</option>
                  </select></div>
                <div><label className="form-label">Outstanding balance reminder frequency</label>
                  <select className="form-select" value={settings.balance_reminder_frequency_days} onChange={e => setSettingField('balance_reminder_frequency_days', parseInt(e.target.value, 10))}>
                    <option value={1}>Every day</option><option value={3}>Every 3 days</option><option value={7}>Once a week</option>
                  </select></div>
                <div><label className="form-label">Session reminder lead time</label>
                  <select className="form-select" value={settings.session_reminder_lead_hours} onChange={e => setSettingField('session_reminder_lead_hours', parseInt(e.target.value, 10))}>
                    <option value={1}>1 hour before</option><option value={24}>24 hours before</option><option value={48}>48 hours before</option>
                  </select></div>
                <button className="btn-secondary" disabled={settingsSaving} onClick={saveSettings}>Update Cooldowns</button>
              </div>
            </div>
            <div className="card" style={{ padding: '22px 20px' }}>
              <div className="section-title" style={{ marginBottom: 14 }}>Delivery Channels</div>
              <div className="toggle-wrap"><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>In-App Notifications</div><label className="toggle"><input type="checkbox" checked={settings.channel_in_app} onChange={() => toggleSetting('channel_in_app')} /><span className="toggle-slider" /></label></div>
              <div className="toggle-wrap"><div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>Email Notifications</div><label className="toggle"><input type="checkbox" checked={settings.channel_email} onChange={() => toggleSetting('channel_email')} /><span className="toggle-slider" /></label></div>
              <div className="toggle-wrap" style={{ borderBottom: 'none' }}>
                <div style={{ fontSize: 13, color: '#0F172A', fontWeight: 500 }}>SMS Notifications</div>
                <label className="toggle"><input type="checkbox" checked={settings.channel_sms} onChange={() => toggleSetting('channel_sms')} /><span className="toggle-slider" /></label>
              </div>
            </div>
          </div>
        </div>
        )}
      </div>

      <div className="page-footer"><span style={{ fontSize: 12, color: '#94A3B8' }}>© 2026 KID Clinic Information Management System · All rights reserved</span></div>

    </div>
  );
}

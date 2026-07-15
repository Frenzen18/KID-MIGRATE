import { db } from '../supabase.js';
import { logAudit } from './audit.js';

/** One-line summary of a notification send for the Security Audit Logs trail. */
export function describeNotification(title, target_role, target_user) {
  return `Sent "${title}" to ${target_role ? 'role: ' + target_role : target_user ? 'a specific user' : 'unknown target'}`;
}

/**
 * Fires a real in-app notification for a clinic event, gated by the matching
 * toggle in notification_settings (12.4 Configuration), the in-app channel
 * switch, and cooldown_minutes, so turning a toggle off actually stops that
 * notification, and a burst of the same event (e.g. a webhook retry) doesn't
 * spam the same recipient, instead of the settings being cosmetic. Never
 * throws, a notification failure must not break the caller's request (same
 * contract as logAudit).
 */
export async function notifyEvent(settingKey, { title, body, icon, target_user, target_role }) {
  if (!target_user && !target_role) return null;
  try {
    let cooldownMinutes = 0;
    if (settingKey) {
      const { data: settings } = await db.from('notification_settings')
        .select(settingKey + ', channel_in_app, cooldown_minutes').eq('id', 1).maybeSingle();
      if (settings && (settings[settingKey] === false || settings.channel_in_app === false)) return null;
      cooldownMinutes = settings?.cooldown_minutes || 0;
    }

    if (settingKey && cooldownMinutes > 0) {
      const since = new Date(Date.now() - cooldownMinutes * 60000).toISOString();
      let dupQuery = db.from('notifications').select('id').eq('event_key', settingKey).gte('created_at', since).limit(1);
      dupQuery = target_user ? dupQuery.eq('target_user', target_user) : dupQuery.eq('target_role', target_role);
      const { data: recent } = await dupQuery;
      if (recent?.length) return null;
    }

    const { data, error } = await db.from('notifications').insert({
      title, body: body || '', icon: icon || 'fa-bell',
      target_user: target_user || null, target_role: target_role || null,
      event_key: settingKey || null
    }).select().single();
    if (error) { console.error('notification insert failed:', error.message); return null; }

    // Every real send lands in the Security Audit Logs trail (table_name
    // 'notifications'), same as account/client/payment/reservation events,     // this is a system-triggered send, so there's no created_by.
    await logAudit({
      table_name: 'notifications', record_id: data.id, action: 'create',
      description: describeNotification(title, target_role, target_user)
    });

    return data;
  } catch (e) {
    console.error('notifyEvent failed:', e.message);
    return null;
  }
}

/** True unless the given delivery channel (e.g. 'channel_email') has been switched off in 12.4 Configuration. */
export async function channelEnabled(channel) {
  try {
    const { data } = await db.from('notification_settings').select(channel).eq('id', 1).maybeSingle();
    return !data || data[channel] !== false;
  } catch (e) {
    console.error('channelEnabled check failed:', e.message);
    return true;
  }
}

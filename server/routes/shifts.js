import { Router } from 'express';
import { db } from '../supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sendMail } from '../mailer.js';
import { logAudit } from '../lib/audit.js';
import { notifyEvent, channelEnabled } from '../lib/notify.js';

const router = Router();
router.use(requireAuth);

/** 24h hour → "8:00 AM" slot label. */
export function hourLabel(h) {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return hr + ':00 ' + (h >= 12 ? 'PM' : 'AM');
}

/** "8:00 AM" / "10:30 AM" → 24h hour of the slot (10:30 counts as the 10 o'clock hour). */
export function labelToHour(label) {
  const m = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(String(label).trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h;
}

// Mon..Sun. Sunday (index 6) defaults to closed, admins opt individual
// therapists into Sunday coverage via the 3.2.2 availability matrix.
const ALL_WORK_DAYS = [true, true, true, true, true, true, false];

/** Pads a legacy 6-length (Mon-Sat) array with a closed Sunday instead of discarding it. */
function normalizeWorkDays(wd) {
  if (Array.isArray(wd) && wd.length === 7) return wd;
  if (Array.isArray(wd) && wd.length === 6) return [...wd, false];
  return ALL_WORK_DAYS;
}

/** "YYYY-MM-DD" → work_days index (Mon=0 … Sat=5, Sun=6). */
export function workDayIndex(dateStr) {
  return (new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

/** True if this shift covers the given date (working day). */
export function worksOn(shift, dateStr) {
  const idx = workDayIndex(dateStr);
  return normalizeWorkDays(shift.work_days)[idx] !== false;
}

/** True if hour `h` falls within this shift's lunch break, if it has one. */
export function isLunchHour(shift, h) {
  return shift.lunch_start_hour != null && shift.lunch_end_hour != null
    && h >= shift.lunch_start_hour && h < shift.lunch_end_hour;
}

/**
 * All active profiles of the given roles with their shift. Profiles without a
 * shift row yet get the clinic default (8 AM – 5 PM) created on the spot, so
 * the schedule is always complete and never undefined.
 */
export async function getShiftsForRoles(roles) {
  const { data: profiles, error } = await db.from('profiles')
    .select('id, full_name, email, role')
    .in('role', roles).eq('active', true)
    .order('full_name');
  if (error) throw new Error(error.message);
  if (!profiles?.length) return [];

  const { data: shifts } = await db.from('shifts').select('*');
  const byProfile = Object.fromEntries((shifts || []).map(s => [s.therapist_id, s]));

  const out = [];
  for (const t of profiles) {
    let s = byProfile[t.id];
    if (!s) {
      const { data: created } = await db.from('shifts')
        .insert({ therapist_id: t.id, start_hour: 8, end_hour: 17 })
        .select().single();
      s = created || { start_hour: 8, end_hour: 17 };
    }
    out.push({
      therapist_id: t.id,
      name: t.full_name,
      email: t.email,
      role: t.role,
      start_hour: s.start_hour,
      end_hour: s.end_hour,
      lunch_start_hour: s.lunch_start_hour ?? null,
      lunch_end_hour: s.lunch_end_hour ?? null,
      work_days: normalizeWorkDays(s.work_days)
    });
  }
  return out;
}

/** All active therapists (OT/Speech) with their shift, this is the set that
 *  actually drives booking capacity (see server/routes/reservations.js). */
export async function getTherapistShifts() {
  return getShiftsForRoles(['ot', 'speech']);
}

/**
 * GET /api/shifts, therapist shift schedule (staff-side), drives real booking
 * capacity. ?scope=admin instead returns Admin/Staff accounts' own shift +
 * availability rows, tracked the same way but purely for schedule visibility,
 * never fed into booking slot generation.
 */
router.get('/', requireRole('admin', 'staff', 'ot', 'speech'), async (req, res) => {
  try {
    const roles = req.query.scope === 'admin' ? ['admin', 'staff'] : ['ot', 'speech'];
    res.json(await getShiftsForRoles(roles));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/shifts/:therapistId  { start_hour, end_hour, work_days? }
 * Saves the shift for a therapist OR an admin/staff account (same table,
 * same shape), then handles the "sudden change" case: any future active
 * booking assigned to this therapist that now falls OUTSIDE the shift is
 * flagged back to pending for rescheduling, and the parent is notified
 * in-app and by email. Admin/staff are never assigned as a booking's
 * therapist, so this reassignment sweep is naturally a no-op for them.
 */
router.put('/:therapistId', requireRole('admin', 'staff'), async (req, res) => {
  try {
  const { data: therapist } = await db.from('profiles')
    .select('id, full_name').eq('id', req.params.therapistId).in('role', ['ot', 'speech', 'admin', 'staff']).maybeSingle();
  if (!therapist) return res.status(404).json({ error: 'Staff member not found' });

  // Partial update: fields not sent keep their current value.
  const { data: current } = await db.from('shifts').select('*').eq('therapist_id', therapist.id).maybeSingle();
  const start = 'start_hour' in (req.body || {}) ? parseInt(req.body.start_hour, 10) : (current?.start_hour ?? 8);
  const end = 'end_hour' in (req.body || {}) ? parseInt(req.body.end_hour, 10) : (current?.end_hour ?? 17);
  if (isNaN(start) || isNaN(end) || start < 6 || end > 21 || start >= end) {
    return res.status(400).json({ error: 'Shift start must be before shift end, between 6:00 AM and 9:00 PM.' });
  }
  let work_days = normalizeWorkDays(current?.work_days);
  if ('work_days' in (req.body || {})) {
    const wd = req.body.work_days;
    if (!Array.isArray(wd) || wd.length !== 7 || wd.some(v => typeof v !== 'boolean')) {
      return res.status(400).json({ error: 'work_days must be 7 true/false values (Mon–Sun).' });
    }
    if (!wd.some(Boolean)) {
      return res.status(400).json({ error: 'A therapist needs at least one working day.' });
    }
    work_days = wd;
  }

  // Optional lunch break, an hour range within the shift with no bookings.
  // Sending either field as null/empty clears the break entirely.
  const body = req.body || {};
  let lunch_start_hour = 'lunch_start_hour' in body ? body.lunch_start_hour : (current?.lunch_start_hour ?? null);
  let lunch_end_hour = 'lunch_end_hour' in body ? body.lunch_end_hour : (current?.lunch_end_hour ?? null);
  if (lunch_start_hour === '' || lunch_start_hour == null) lunch_start_hour = null;
  if (lunch_end_hour === '' || lunch_end_hour == null) lunch_end_hour = null;
  if (lunch_start_hour != null || lunch_end_hour != null) {
    lunch_start_hour = parseInt(lunch_start_hour, 10);
    lunch_end_hour = parseInt(lunch_end_hour, 10);
    if (isNaN(lunch_start_hour) || isNaN(lunch_end_hour) || lunch_start_hour >= lunch_end_hour
      || lunch_start_hour < start || lunch_end_hour > end) {
      return res.status(400).json({ error: 'Lunch break must fall within the shift hours, with start before end.' });
    }
  }

  const { error: upErr } = await db.from('shifts').upsert(
    {
      therapist_id: therapist.id,
      start_hour: start,
      end_hour: end,
      lunch_start_hour,
      lunch_end_hour,
      work_days,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'therapist_id' }
  );
  if (upErr) return res.status(500).json({ error: upErr.message });

  await logAudit({
    table_name: 'shifts', record_id: therapist.id, action: 'update',
    description: `Updated shift for ${therapist.full_name}, ${hourLabel(start)} to ${hourLabel(end)}`,
    updated_by: req.user.id
  });

  // Sudden shift change → find future bookings that no longer fit
  // (outside the new hours, or on a day the therapist no longer works).
  const todayPH = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: bookings } = await db.from('reservations')
    .select('*, clients(full_name)')
    .eq('therapist_name', therapist.full_name)
    .in('status', ['pending', 'confirmed', 'rescheduled'])
    .gte('date', todayPH);
  const affected = (bookings || []).filter(r => {
    const h = labelToHour(r.time_slot);
    if (h == null || h < start || h >= end) return true;
    if (!worksOn({ work_days }, r.date)) return true;
    return isLunchHour({ lunch_start_hour, lunch_end_hour }, h);
  });

  for (const r of affected) {
    try {
      const { error: updErr } = await db.from('reservations').update({
        status: 'pending',
        notes: ((r.notes ? r.notes + ' · ' : '') + '⚠ Therapist shift changed, needs rescheduling')
      }).eq('id', r.id);
      if (updErr) { console.error('Shift-change reservation update error:', updErr.message); continue; }

      await logAudit({
        table_name: 'reservations', record_id: r.id, action: 'update',
        description: `Flagged for rescheduling, ${therapist.full_name}'s shift changed (was ${r.date} ${r.time_slot})`,
        updated_by: req.user.id
      });

      if (!r.created_by) continue;
      const childName = r.clients?.full_name || 'your child';
      const when = `${r.date} at ${r.time_slot}`;

      // In-app notification for the parent
      await notifyEvent('notify_shift_reassignment', {
        title: 'Session needs rescheduling',
        body: `Due to a schedule change at the clinic, ${childName}'s session on ${when} will be rescheduled. We will contact you with a new time, you may also book a new slot from your portal.`,
        icon: 'fa-calendar-xmark',
        target_user: r.created_by
      });

      // Email, fire-and-forget so a mail hiccup never blocks the shift edit.
      const { data: parent } = await db.from('profiles').select('email, full_name').eq('id', r.created_by).maybeSingle();
      if (parent?.email && await channelEnabled('channel_email')) {
        sendMail({
          to: parent.email,
          subject: 'Session rescheduling needed: KID Clinic',
          html: `
            <div style="font-family: 'Inter', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
              <div style="text-align: center; margin-bottom: 24px;">
                <h2 style="color: #1F4E9E; margin: 0;">KID Clinic</h2>
                <p style="color: #64748B; font-size: 13px;">Pediatric Speech & Occupational Therapy</p>
              </div>
              <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 24px;">
                <p style="color: #334155; font-size: 14px; margin: 0 0 16px;">Hi ${parent.full_name || 'there'},</p>
                <p style="color: #64748B; font-size: 13px; margin: 0 0 16px; line-height: 1.7;">
                  Due to a sudden change in our therapists' schedule, <strong>${childName}</strong>'s session on
                  <strong>${when}</strong> needs to be rescheduled. We apologize for the inconvenience.
                </p>
                <p style="color: #64748B; font-size: 13px; margin: 0; line-height: 1.7;">
                  The clinic will contact you with a new time, or you can book a new slot from your parent portal.
                </p>
              </div>
            </div>
          `
        }).catch(e => console.error('Shift-change email error:', e.message));
      }
    } catch (rowErr) {
      // Never let one bad booking row abort the whole shift save.
      console.error('Shift-change per-booking error for reservation', r.id, ':', rowErr.message);
    }
  }

  res.json({
    ok: true,
    therapist: therapist.full_name,
    start_hour: start,
    end_hour: end,
    lunch_start_hour,
    lunch_end_hour,
    work_days,
    affected: affected.length
  });
  } catch (e) {
    console.error('PUT /api/shifts/:therapistId error:', e);
    res.status(500).json({ error: e.message || 'Failed to save shift' });
  }
});

export default router;

import { db } from '../supabase.js';
import { logAudit } from './audit.js';
import { notifyEvent } from './notify.js';

/**
 * Releases guardian self-bookings that have sat 'awaiting_payment' past their
 * payment_expires_at deadline (see server/routes/reservations.js, POST /):
 * the slot is freed for someone else and the never-paid invoice is removed,
 * mirroring the manual-cancel cleanup in PUT /:id.
 */
export async function expireUnpaidBookingHolds() {
  try {
    const { data: expired, error } = await db.from('reservations')
      .select('id, client_id, date, time_slot, created_by, clients(full_name)')
      .eq('status', 'awaiting_payment')
      .lt('payment_expires_at', new Date().toISOString());
    if (error) { console.error('expireUnpaidBookingHolds: query failed:', error.message); return; }

    for (const r of expired || []) {
      try {
        await db.from('reservations').update({
          status: 'cancelled',
          notes: 'Payment window expired, slot released'
        }).eq('id', r.id);
        await db.from('payments').delete().eq('reservation_id', r.id).eq('status', 'pending');

        await logAudit({
          table_name: 'reservations', record_id: r.id, action: 'update',
          description: `Booking hold expired unpaid, slot released (${r.date} ${r.time_slot})`
        });

        if (r.created_by) {
          await notifyEvent(null, {
            title: 'Booking hold expired',
            body: `Your held slot on ${r.date} at ${r.time_slot} for ${r.clients?.full_name || 'your child'} was released because payment wasn't completed in time. You're welcome to book again.`,
            icon: 'fa-calendar-xmark',
            target_user: r.created_by
          });
        }
      } catch (rowErr) {
        console.error('expireUnpaidBookingHolds: per-row error for reservation', r.id, ':', rowErr.message);
      }
    }
  } catch (e) {
    console.error('expireUnpaidBookingHolds failed:', e.message);
  }
}

import { db } from './supabase.js';

const { data: payment, error } = await db.from('payments')
  .select('*, clients(full_name, client_code)')
  .eq('invoice_no', 'INV-20260726-00101')
  .maybeSingle();

if (error) { console.error(error); process.exit(1); }
if (!payment) { console.log('No payment found with that invoice_no'); process.exit(0); }

console.log('--- Target payment ---');
console.log(JSON.stringify(payment, null, 2));

const { data: siblings } = await db.from('payments')
  .select('id, invoice_no, client_id, fee_type, status, reservation_id, amount, created_at')
  .eq('client_id', payment.client_id).eq('fee_type', 'session')
  .order('created_at', { ascending: true });

console.log('\n--- All session payments for this client (ordered oldest first) ---');
console.log(JSON.stringify(siblings, null, 2));

const { data: futureRes } = await db.from('reservations')
  .select('id, date, time_slot, status, session_type, created_at, client_id')
  .eq('client_id', payment.client_id)
  .order('date', { ascending: true });
console.log('\n--- This client\'s reservations ---');
console.log(JSON.stringify(futureRes, null, 2));

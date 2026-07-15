import { db } from './supabase.js';

/**
 * Next sequential code "<PREFIX>-YYYY-NNNN" for a table column (year of
 * creation + 4-digit sequence per year). Codes are UNIQUE per table so every
 * record gets a permanent human-readable ID alongside its row id.
 */
async function nextCode(table, column, prefixBase, year) {
  const prefix = `${prefixBase}-${year}-`;
  const { data } = await db
    .from(table)
    .select(column)
    .like(column, prefix + '%')
    .order(column, { ascending: false })
    .limit(1);
  const lastNum = data?.[0]?.[column] ? parseInt(data[0][column].slice(prefix.length), 10) : 0;
  return prefix + String(lastNum + 1).padStart(4, '0');
}

/** Account ID: KID-YYYY-NNNN (profiles.user_code). */
export const nextUserCode = (year = new Date().getFullYear()) =>
  nextCode('profiles', 'user_code', 'KID', year);

/** Client ID: CLI-YYYY-NNNN (clients.client_code). Pass a year to backfill by creation date. */
export const nextClientCode = (year = new Date().getFullYear()) =>
  nextCode('clients', 'client_code', 'CLI', year);

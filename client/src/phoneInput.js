/**
 * Live PH mobile number filter for uncontrolled phone inputs: strips
 * non-digits (keeping a leading "+"), then caps the length to whichever
 * accepted format the user is typing, 09XXXXXXXXX (11 digits) or
 * +639XXXXXXXXX (+63 plus 10 digits), so no amount of extra digits can be
 * pasted or typed in. Mirrors normalizePhone() on the server.
 */
export function filterPhoneInput(raw) {
  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '').slice(0, 12); // 63 + 10-digit mobile number
    return '+' + digits;
  }
  return raw.replace(/\D/g, '').slice(0, 11); // 09XXXXXXXXX
}

/**
 * Groups a clean PH mobile number for display only, "+639171234567" reads as
 * "+63 917 123 4567" (or the local "09171234567" as "0917 123 4567"), the
 * digits themselves are unchanged, this never affects what's actually stored
 * or submitted, callers keep using filterPhoneInput()/plain digit-stripping
 * on the raw value for that.
 */
export function formatPhoneDisplay(raw) {
  if (!raw) return raw;
  if (raw.startsWith('+63')) {
    const digits = raw.slice(3).replace(/\D/g, '').slice(0, 10);
    const groups = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 10)].filter(Boolean);
    return '+63' + (groups.length ? ' ' + groups.join(' ') : '');
  }
  if (raw.startsWith('0')) {
    const digits = raw.replace(/\D/g, '').slice(0, 11);
    const groups = [digits.slice(0, 4), digits.slice(4, 7), digits.slice(7, 11)].filter(Boolean);
    return groups.join(' ');
  }
  return raw;
}

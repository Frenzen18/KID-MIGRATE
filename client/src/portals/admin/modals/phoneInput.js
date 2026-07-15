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

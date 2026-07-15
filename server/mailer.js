/**
 * Shared Gmail SMTP transporter, single source of truth so TLS/port
 * settings are explicit and auditable, instead of relying on nodemailer's
 * implicit `service: 'gmail'` preset duplicated across route files.
 *
 * Gmail SMTP: smtp.gmail.com:465 with `secure: true` (SSL/TLS from the
 * first byte of the connection, not upgraded later via STARTTLS).
 * Auth must be a Gmail App Password (requires 2-Step Verification on the
 * account), never the account's real login password.
 */
let cachedTransporter = null;

async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  if (!process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
    throw new Error('SMTP_EMAIL / SMTP_PASSWORD are not configured.');
  }

  const nodemailer = (await import('nodemailer')).default;
  cachedTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // SSL/TLS, required, not optional
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD
    },
    tls: {
      // Reject any connection that can't negotiate a valid TLS handshake.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    }
  });
  return cachedTransporter;
}

/** Sends an HTML email through the shared Gmail SMTP transporter. */
export async function sendMail({ to, subject, html }) {
  const transporter = await getTransporter();
  await transporter.sendMail({
    from: `"KID Clinic" <${process.env.SMTP_EMAIL}>`,
    to,
    subject,
    html
  });
}

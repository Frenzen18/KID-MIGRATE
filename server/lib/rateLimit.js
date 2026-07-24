import { rateLimit } from 'express-rate-limit';

const isProd = process.env.NODE_ENV === 'production';
export const MIN = 60 * 1000;

/** Shared rate-limiter factory (per IP). Real windows in production, short
 *  windows in dev so testing isn't stuck waiting on a 15-minute lockout. */
export function makeLimiter(windowMs, max, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message })
  });
}

export { isProd };

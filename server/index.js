import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import reservationRoutes from './routes/reservations.js';
import cmsRoutes from './routes/cms.js';
import paymentRoutes from './routes/payments.js';
import userRoutes from './routes/users.js';
import shiftRoutes from './routes/shifts.js';
import analyticsRoutes from './routes/analytics.js';
import notificationRoutes from './routes/notifications.js';
import auditRoutes from './routes/audit.js';
import reportRoutes from './routes/reports.js';
import gasRoutes from './routes/gas.js';
import devFunctionalFieldsRoutes from './routes/devFunctionalFields.js';
import { handlePaymongoWebhook } from './lib/paymongoWebhook.js';
import { runReminderSweep } from './lib/reminders.js';

dotenv.config();
const app = express();

// Restrict browser cross-origin access to known frontend origin(s) instead of
// allowing any site to call this API. Set ALLOWED_ORIGINS (comma-separated)
// in production; local dev defaults cover the Vite dev server.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // No Origin header = same-origin, curl, server-to-server (e.g. webhooks), always allow.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));

// Must be registered with a raw body BEFORE express.json(), PayMongo's
// signature is computed over the exact bytes it sent, so parsing to JSON
// first would make verification impossible.
app.post('/api/payments/webhook/paymongo', express.raw({ type: 'application/json' }), handlePaymongoWebhook);

app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'kid-clinic-api' }));

app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/cms', cmsRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/shifts', shiftRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/gas', gasRoutes);
app.use('/api/dev-functional-fields', devFunctionalFieldsRoutes);

// central error fallback
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`KID clinic API running on http://localhost:${port}`));

// Session/balance reminder sweep, see server/lib/reminders.js. Runs on a
// timer since there's no external cron; 15 min keeps the 1-hour lead-time
// option reasonably accurate without hammering the database.
const REMINDER_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
setInterval(runReminderSweep, REMINDER_SWEEP_INTERVAL_MS);
runReminderSweep();

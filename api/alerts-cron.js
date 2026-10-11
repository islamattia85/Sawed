/**
 * GET /api/alerts-cron — run once a day by Vercel Cron (vercel.json).
 *
 * For each signed-in household that turned on "Email me these", works out
 * today's alerts (api/_alerts.js) and emails any not sent before; alert_log
 * holds one row per email so a rerun never sends a second copy. The reading
 * and sending is in api/_alerts-run.js.
 *
 * Needs CRON_SECRET (Vercel sends it as a bearer token on cron calls),
 * SUPABASE_SERVICE_ROLE_KEY, and for email RESEND_API_KEY and MAIL_FROM.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminDb, sendEmail } from './_server.js';
import { runAlerts } from './_alerts-run.js';

export const config = { maxDuration: 60 };

async function loadTariffs() {
  try {
    if (process.env.APP_URL) {
      const r = await fetch(`${process.env.APP_URL}/tariffs.json`);
      if (r.ok) return await r.json();
    }
  } catch { /* fall through to the bundled copy */ }
  return JSON.parse(readFileSync(join(process.cwd(), 'public', 'tariffs.json'), 'utf8'));
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Not allowed.' });
  const db = adminDb();
  if (!db) return res.status(503).json({ error: 'Not configured.' });

  const raw = await loadTariffs();
  const tariffs = Array.isArray(raw) ? raw : raw.tariffs || [];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });

  // Only households that turned emails on, a few answers each, a page at a
  // time, within the run's time (api/_alerts-run.js).
  const run = await runAlerts({ db, tariffs, today, appUrl: process.env.APP_URL, send: sendEmail });
  if (!run.ok) return res.status(500).json({ error: run.error });

  // Retention: data past its keeping period goes (supabase/security_2026_10.sql).
  const { data: purged } = await db.rpc('purge_expired').then((r) => r, () => ({ data: null }));
  return res.status(200).json({ ...run, purged });
}

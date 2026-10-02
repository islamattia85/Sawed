/**
 * GET /api/alerts-cron — run once a day by Vercel Cron (vercel.json).
 *
 * For each signed-in household that turned on "Email me these", works out
 * today's alerts (api/_alerts.js) and emails any not sent before; alert_log
 * holds one row per email so a rerun never sends a second copy.
 *
 * Needs CRON_SECRET (Vercel sends it as a bearer token on cron calls),
 * SUPABASE_SERVICE_ROLE_KEY, and for email RESEND_API_KEY and MAIL_FROM.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminDb, sendEmail } from './_server.js';
import { alertsFor } from './_alerts.js';

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

  const { data: rows, error } = await db.from('profiles').select('id, email, app_state').not('app_state', 'is', null).limit(5000);
  if (error) return res.status(500).json({ error: 'Could not read profiles.' });

  let sent = 0, skipped = 0;
  for (const p of rows || []) {
    let st = p.app_state;
    if (typeof st === 'string') { try { st = JSON.parse(st); } catch { continue; } }
    const due = alertsFor(st, tariffs, today, process.env.APP_URL);
    for (const a of due) {
      // Claim the key first: if the row exists, it was already sent.
      const { error: dup } = await db.from('alert_log').insert({ user_id: p.id, alert_key: a.key });
      if (dup) { skipped++; continue; }
      const ok = await sendEmail({ to: p.email, subject: a.subject, text: `${a.text}\n\nYou get this because you turned on email alerts in Peakless. Turn them off in My Peakless.` });
      if (ok) sent++;
      else await db.from('alert_log').delete().eq('user_id', p.id).eq('alert_key', a.key);
    }
  }
  // Retention: data past its keeping period goes (supabase/security_2026_10.sql).
  const { data: purged } = await db.rpc('purge_expired').then((r) => r, () => ({ data: null }));
  return res.status(200).json({ ok: true, households: (rows || []).length, sent, skipped, purged });
}

/**
 * Shared by the server functions: who may call them, and the database client.
 * Files under api/ starting with "_" are not deployed as routes.
 */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fbsdlpptcuxfkmyhcfna.supabase.co';

// Only the app itself may call these. A pattern for every *.vercel.app would
// let anyone's site on Vercel in, so the list names this project's own hosts:
// the live address, and the deployment and branch addresses Vercel sets for
// each build. APP_ORIGIN adds a custom domain.
const exact = (h) => new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const ALLOWED = [/^https:\/\/peakless[a-z0-9-]*\.vercel\.app$/, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^capacitor:\/\/localhost$/];
for (const v of [process.env.APP_ORIGIN, process.env.APP_URL]) if (v) ALLOWED.push(exact(v.replace(/\/+$/, '')));
for (const v of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) if (v) ALLOWED.push(exact(`https://${v}`));
export const originAllowed = (origin) => !!origin && ALLOWED.some((r) => r.test(origin));

/** The database as the server: bypasses row-level security, so never sent to a browser. */
export function adminDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function readBody(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return null; } }
  return req.body || null;
}

/**
 * Guard shared by every endpoint. Returns true when it has already replied.
 * A browser always sends Origin on these calls, so a call without one is a
 * script, and is refused.
 */
export function guard(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only.' }); return true; }
  if (!originAllowed(req.headers.origin || '')) { res.status(403).json({ error: 'Not allowed.' }); return true; }
  return false;
}

/**
 * At most `max` calls an hour from one address to one endpoint. The address
 * is kept only as a salted hash, and rows older than a day are removed by the
 * daily job. Without the database it lets the call through: the limit
 * protects the bill, it must never take the app down.
 */
export async function rateLimited(req, res, bucket, max) {
  const db = adminDb();
  if (!db) return false;
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const key = createHash('sha256').update(`${process.env.RATE_SALT || process.env.SUPABASE_URL || 'peakless'}|${bucket}|${ip}`).digest('hex').slice(0, 32);
  const since = new Date(Date.now() - 3600e3).toISOString();
  const { count, error } = await db.from('api_hits').select('key', { count: 'exact', head: true }).eq('key', key).gte('at', since);
  if (error) return false;
  if ((count || 0) >= max) { res.status(429).json({ error: 'Too many tries — please wait a while and try again.' }); return true; }
  await db.from('api_hits').insert({ key });
  return false;
}

/** Transactional email through Resend, when configured. Never throws. */
export async function sendEmail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
    });
    return r.ok;
  } catch { return false; }
}

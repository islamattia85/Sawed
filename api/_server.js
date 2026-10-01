/**
 * Shared by the server functions: who may call them, and the database client.
 * Files under api/ starting with "_" are not deployed as routes.
 */
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fbsdlpptcuxfkmyhcfna.supabase.co';

// Only the app itself may call these. Browsers always send Origin on a
// cross-site POST; Vercel's firewall rate limits cover scripted abuse.
const ALLOWED = [/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, /^capacitor:\/\/localhost$/];
if (process.env.APP_ORIGIN) ALLOWED.push(new RegExp(`^${process.env.APP_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
export const originAllowed = (origin) => !origin || ALLOWED.some((r) => r.test(origin));

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

/** Guard shared by every endpoint. Returns true when it has already replied. */
export function guard(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only.' }); return true; }
  if (!originAllowed(req.headers.origin || '')) { res.status(403).json({ error: 'Not allowed.' }); return true; }
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

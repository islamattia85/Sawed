/**
 * POST /api/error — an error from the app, as reported by src/errors.ts.
 * No personal data: the page scrubs it, and this keeps only short, known
 * fields. Kept 30 days (purge_expired), so a fault can be traced, then gone.
 */
import { guard, readBody, adminDb, rateLimited } from './_server.js';

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

export default async function handler(req, res) {
  if (guard(req, res)) return;
  if (await rateLimited(req, res, 'error', 30)) return;
  const b = readBody(req) || {};
  if (!str(b.message, 300)) return res.status(400).json({ error: 'No error.' });
  const db = adminDb();
  if (!db) return res.status(202).json({ ok: false });
  await db.from('client_errors').insert({
    message: str(b.message, 300), stack: str(b.stack, 2000), source: str(b.source, 200),
    build: str(b.build, 20), version: str(b.version, 20), screen: str(b.screen, 30), ua: str(b.ua, 160),
  });
  return res.status(200).json({ ok: true });
}

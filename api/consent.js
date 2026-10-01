/** POST /api/consent — record a consent decision (what was shown, and the answer). */
import { guard, readBody, adminDb } from './_server.js';

export const CONSENT_KINDS = ['analytics'];

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const b = readBody(req) || {};
  if (!CONSENT_KINDS.includes(b.kind) || typeof b.granted !== 'boolean') return res.status(400).json({ error: 'Bad consent.' });
  const db = adminDb();
  if (!db) return res.status(202).json({ ok: false });
  await db.from('consents').insert({
    kind: b.kind, granted: b.granted,
    session_id: typeof b.session_id === 'string' ? b.session_id.slice(0, 40) : null,
    text_version: String(b.text_version || 'v1').slice(0, 20),
  });
  return res.status(200).json({ ok: true });
}

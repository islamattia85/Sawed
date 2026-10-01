/**
 * POST /api/delete-account — delete the signed-in person's account and data.
 * Required by the App Store for any app with sign-in. The caller proves who
 * they are with their own session token; the server deletes with its key.
 */
import { guard, adminDb } from './_server.js';

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const db = adminDb();
  if (!db) return res.status(503).json({ error: 'Not available yet.' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in first.' });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Sign in first.' });
  const id = data.user.id;
  await db.from('profiles').delete().eq('id', id);
  await db.from('leads').update({ user_id: null }).eq('user_id', id);
  const { error: delErr } = await db.auth.admin.deleteUser(id);
  if (delErr) return res.status(500).json({ error: 'Could not delete the account. Please contact us.' });
  return res.status(200).json({ ok: true });
}

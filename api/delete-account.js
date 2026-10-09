/**
 * POST /api/delete-account — delete the signed-in person's account and data.
 * Required by the App Store for any app with sign-in. The caller proves who
 * they are with their own session token; the server deletes with its key.
 */
import { guard, adminDb, sendEmail } from './_server.js';

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const db = adminDb();
  if (!db) return res.status(503).json({ error: 'Not available yet.' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in first.' });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Sign in first.' });
  const id = data.user.id;
  const email = String(data.user.email || '').toLowerCase();
  // Erasure means everything that names them: their quote requests too (by
  // account, and by email for any sent before they signed in), and the
  // installers who were given their details are told to delete them.
  const byUser = (await db.from('leads').select('id').eq('user_id', id)).data || [];
  const byEmail = email ? (await db.from('leads').select('id').eq('email', email)).data || [] : [];
  const leadIds = [...new Set([...byUser, ...byEmail].map((l) => l.id))];
  if (leadIds.length) {
    const { data: told } = await db.from('lead_assignments')
      .select('status, installers(email)').in('lead_id', leadIds).not('status', 'in', '(sent,declined)');
    for (const t of told || []) {
      if (t.installers?.email) await sendEmail({ to: t.installers.email, subject: 'A homeowner has asked for their data to be deleted',
        text: 'A homeowner whose quote request you accepted on Peakless has deleted their account. Under GDPR, please delete '
          + 'the contact details and any other personal data you hold from that request, unless you are already under contract with them.' });
    }
    await db.from('lead_assignments').delete().in('lead_id', leadIds);
    await db.from('leads').delete().in('id', leadIds);
  }
  await db.from('alert_log').delete().eq('user_id', id);
  await db.from('consents').delete().eq('user_id', id);
  await db.from('profiles').delete().eq('id', id);
  const { error: delErr } = await db.auth.admin.deleteUser(id);
  if (delErr) return res.status(500).json({ error: 'Could not delete the account. Please contact us.' });
  return res.status(200).json({ ok: true });
}

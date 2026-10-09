/**
 * POST /api/event — anonymous funnel events, sent only with analytics consent.
 * A fixed list of names and no personal data: which parts of the app are
 * used, so we know what to improve. If partners are switched on
 * (src/features.js), a partner is billed on these counts too.
 */
import { guard, readBody, adminDb } from './_server.js';

export const EVENT_NAMES = ['switch_click', 'lead_submitted', 'quote_uploaded', 'report_downloaded', 'pro_viewed'];

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const b = readBody(req) || {};
  if (!EVENT_NAMES.includes(b.name)) return res.status(400).json({ error: 'Unknown event.' });
  const db = adminDb();
  if (!db) return res.status(202).json({ ok: false });
  const props = {};
  for (const [k, v] of Object.entries(b.props || {}).slice(0, 12)) {
    if (/^[a-z_]{1,30}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) props[k] = typeof v === 'string' ? v.slice(0, 80) : v;
  }
  await db.from('events').insert({
    name: b.name,
    session_id: typeof b.session_id === 'string' ? b.session_id.slice(0, 40) : null,
    click_id: typeof b.click_id === 'string' ? b.click_id.slice(0, 40) : null,
    props,
  });
  return res.status(200).json({ ok: true });
}

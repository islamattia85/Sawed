/**
 * POST /api/lead — a homeowner asks for installer quotes.
 *
 * Validates, scores and stores the request, offers it to up to three active
 * installers covering the county (route_lead in the database), and emails the
 * homeowner and each installer. Installers see contact details only after
 * accepting, in the portal. Needs SUPABASE_SERVICE_ROLE_KEY; email needs
 * RESEND_API_KEY and MAIL_FROM.
 */
import { guard, readBody, adminDb, sendEmail } from './_server.js';
import { validateLead, scoreLead } from './_lead.js';

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const db = adminDb();
  if (!db) return res.status(503).json({ error: 'Quote requests are not switched on yet.' });

  const { lead, error } = validateLead(readBody(req));
  if (error) return res.status(400).json({ error });
  lead.quality_score = scoreLead(lead);
  // Signed in: the request belongs to the account, so it shows in My Peakless.
  // The token is checked with the auth server, never trusted as sent.
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token) {
    const { data: who } = await db.auth.getUser(token).catch(() => ({ data: null }));
    if (who && who.user) lead.user_id = who.user.id;
  }
  if (lead.phone) lead.phone = lead.phone.replace(/[^\d+]/g, '');

  // The same person asking again within 30 days — same email, or same phone —
  // is an update to their request, not a new lead. The lead keeps its id, so
  // an installer who already has it is never offered (or charged for) it
  // twice: assignments are unique per lead and installer. If the county
  // changed, installers there are offered it too.
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  let q = db.from('leads').select('id').gte('created_at', since).neq('status', 'invalid').order('created_at', { ascending: false }).limit(1);
  q = lead.phone ? q.or(`email.eq.${lead.email},phone.eq.${lead.phone.replace(/[^\d+]/g, '')}`) : q.eq('email', lead.email);
  const { data: prior } = await q;
  let row, updated = false;
  if (prior && prior.length) {
    const { data, error: upErr } = await db.from('leads')
      .update({ ...lead, updated_at: new Date().toISOString() }).eq('id', prior[0].id).select('id').single();
    if (upErr || !data) return res.status(500).json({ error: 'Your update could not be saved. Please try again.' });
    row = data; updated = true;
    await db.from('lead_assignments').update({ updated_at: new Date().toISOString(), details_updated: true }).eq('lead_id', row.id);
  } else {
    const { data, error: insErr } = await db.from('leads').insert(lead).select('id').single();
    if (insErr || !data) return res.status(500).json({ error: 'Your request could not be saved. Please try again.' });
    row = data;
  }

  const { data: matched } = await db.rpc('route_lead', { p_lead: row.id });

  const { data: assigned } = await db.from('lead_assignments')
    .select('assigned_at, installers(company,email)').eq('lead_id', row.id);
  const fresh = (a) => Date.now() - new Date(a.assigned_at).getTime() < 60_000;
  const portal = process.env.APP_URL ? `${process.env.APP_URL}/#installer` : 'the Peakless installer portal';
  for (const a of assigned || []) {
    const i = a.installers;
    if (!i) continue;
    if (!fresh(a)) {
      await sendEmail({ to: i.email, subject: `Updated: solar lead in ${lead.county}`,
        text: `A homeowner you already have has updated their request (no new charge). See the latest details in ${portal}.` });
      continue;
    }
    await sendEmail({
      to: i.email,
      subject: `New solar lead in ${lead.county} (score ${lead.quality_score})`,
      text: `A homeowner in ${lead.county} has asked for a quote: ${lead.spec.panels || '?'} panels (${lead.spec.kwp || '?'} kWp)`
        + `${lead.spec.battery_kwh ? `, ${lead.spec.battery_kwh} kWh battery` : ''}, timeline: ${lead.timeline}.\n\n`
        + `Accept it in ${portal} to see their contact details.`,
    });
  }
  if (!updated) await sendEmail({
    to: lead.email,
    subject: matched > 0 ? 'Your solar quote request has been sent' : 'We have your solar quote request',
    text: matched > 0
      ? `Thanks. Your request has gone to ${matched} SEAI-registered installer${matched > 1 ? 's' : ''} in ${lead.county}. They will contact you directly.`
      : `Thanks. We don't have a partner installer covering ${lead.county} yet; we'll be in touch when we do.`,
  });

  return res.status(200).json({ ok: true, updated, matched: (assigned || []).length });
}

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

  // The same person asking again for the same county within 30 days is not a
  // new lead: installers must never pay twice for one homeowner.
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data: dup } = await db.from('leads').select('id').eq('dedupe_key', lead.dedupe_key).gte('created_at', since).limit(1);
  if (dup && dup.length) return res.status(200).json({ ok: true, duplicate: true });

  const { data: row, error: insErr } = await db.from('leads').insert(lead).select('id').single();
  if (insErr || !row) return res.status(500).json({ error: 'Your request could not be saved. Please try again.' });

  const { data: matched } = await db.rpc('route_lead', { p_lead: row.id });

  const { data: assigned } = await db.from('lead_assignments')
    .select('installers(company,email)').eq('lead_id', row.id);
  const portal = process.env.APP_URL ? `${process.env.APP_URL}/#installer` : 'the Sawed installer portal';
  for (const a of assigned || []) {
    const i = a.installers;
    if (!i) continue;
    await sendEmail({
      to: i.email,
      subject: `New solar lead in ${lead.county} (score ${lead.quality_score})`,
      text: `A homeowner in ${lead.county} has asked for a quote: ${lead.spec.panels || '?'} panels (${lead.spec.kwp || '?'} kWp)`
        + `${lead.spec.battery_kwh ? `, ${lead.spec.battery_kwh} kWh battery` : ''}, timeline: ${lead.timeline}.\n\n`
        + `Accept it in ${portal} to see their contact details.`,
    });
  }
  await sendEmail({
    to: lead.email,
    subject: matched > 0 ? 'Your solar quote request has been sent' : 'We have your solar quote request',
    text: matched > 0
      ? `Thanks. Your request has gone to ${matched} SEAI-registered installer${matched > 1 ? 's' : ''} in ${lead.county}. They will contact you directly.`
      : `Thanks. We don't have a partner installer covering ${lead.county} yet; we'll be in touch when we do.`,
  });

  return res.status(200).json({ ok: true, matched: matched || 0 });
}

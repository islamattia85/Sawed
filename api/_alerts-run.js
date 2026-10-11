/**
 * One run of the daily alert emails, apart from the HTTP handler so it can be
 * tested with a stand-in database (11 Oct 2026).
 *
 * It reads only the households that turned emails on, and from each only the
 * four answers the rules use (api/_alerts.js), a page at a time. It used to
 * read up to 5,000 whole saved homes in one go, meter readings and all
 * (often 100 KB each), so it would have run out of time or memory in the low
 * thousands and silently skipped everyone past 5,000.
 *
 * It stops starting new households when its time is nearly up and says so
 * (more: true). Nothing is sent twice: each email first claims its key in
 * alert_log, so the next run carries on where this one stopped.
 */
import { alertsFor } from './_alerts.js';

/** The answers alertsFor reads, picked out of the saved home by the database. */
export const ALERT_FIELDS = 'id, email, alerts_email:app_state->alerts_email, onboarding_complete:app_state->onboarding_complete, baseline:app_state->>baseline, contract_end:app_state->>contract_end';
export const PAGE = 500;

/**
 * @param {{ db: any, tariffs: any[], today: string, appUrl?: string,
 *   send: (m: { to: string, subject: string, text: string }) => Promise<boolean>,
 *   budgetMs?: number, now?: () => number, page?: number }} o
 */
export async function runAlerts(o) {
  const { db, tariffs, today, appUrl, send } = o;
  const now = o.now || Date.now, page = o.page || PAGE, budget = o.budgetMs ?? 45_000;
  const started = now();
  let households = 0, sent = 0, skipped = 0, more = false;
  for (let from = 0; ; from += page) {
    const { data: rows, error } = await db.from('profiles').select(ALERT_FIELDS)
      .eq('app_state->>alerts_email', 'true').order('id').range(from, from + page - 1);
    if (error) return { ok: from > 0, error: 'Could not read profiles.', households, sent, skipped, more: true };
    for (const p of rows || []) {
      if (now() - started > budget) { more = true; break; }
      households++;
      const home = { alerts_email: p.alerts_email === true || p.alerts_email === 'true', onboarding_complete: p.onboarding_complete === true || p.onboarding_complete === 'true',
        baseline: p.baseline, contract_end: p.contract_end };
      for (const a of alertsFor(home, tariffs, today, appUrl)) {
        // Claim the key first: if the row exists, it was already sent.
        const { error: dup } = await db.from('alert_log').insert({ user_id: p.id, alert_key: a.key });
        if (dup) { skipped++; continue; }
        const ok = await send({ to: p.email, subject: a.subject, text: `${a.text}\n\nYou get this because you turned on email alerts in Peakless. Turn them off in My Peakless.` });
        if (ok) sent++;
        else await db.from('alert_log').delete().eq('user_id', p.id).eq('alert_key', a.key);
      }
    }
    if (more || !rows || rows.length < page) break;
  }
  return { ok: true, households, sent, skipped, more };
}

/**
 * Which alert emails a household should get today. Pure: no network, no
 * database, so the rules are tested on their own.
 *
 * Emails cover what is certain from the price data and the household's own
 * dates: a price change on the plan they are on (three weeks ahead, and
 * again on the day), and their contract ending (a month ahead, and a week
 * ahead). "A cheaper plan exists" needs the full hour-by-hour model, which
 * runs in the app, so it is shown there rather than emailed.
 */

const DAY = 864e5;
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/** @returns {{ key: string, subject: string, text: string }[]} */
export function alertsFor(appState, tariffs, today, appUrl) {
  const s = appState || {};
  if (!s.alerts_email || !s.onboarding_complete) return [];
  const out = [];
  const link = appUrl ? `\n\nOpen Peakless to compare plans: ${appUrl}` : '';
  const plan = (tariffs || []).find((t) => t.id === s.baseline);
  const pc = plan && plan.price_change;
  if (pc && pc.effective_date) {
    const d = days(today, pc.effective_date);
    const up = pc.direction !== 'decrease';
    const pct = Math.round(Math.max(pc.pct || 0, ...Object.values(pc.pct_bands || {})) * 100);
    const what = `${plan.supplier} ${up ? 'raises' : 'lowers'} the prices on your plan, ${plan.plan}${pct ? `, by up to ${pct}%` : ''}`;
    if (d <= 21 && d > 1) out.push({ key: `price:${plan.id}:${pc.effective_date}:ahead`,
      subject: `Your electricity prices ${up ? 'rise' : 'fall'} on ${fmt(pc.effective_date)}`,
      text: `${what} from ${fmt(pc.effective_date)}.${pc.note ? `\n\n${pc.note}` : ''}${up ? '\n\nThere is still time to move to a cheaper plan before it starts.' : ''}${link}` });
    if (d <= 1 && d >= -1) out.push({ key: `price:${plan.id}:${pc.effective_date}:day`,
      subject: `New prices on your plan from ${fmt(pc.effective_date)}`,
      text: `${what} from ${fmt(pc.effective_date)}.${link}` });
  }
  if (s.contract_end) {
    const d = days(today, s.contract_end);
    if (d <= 30 && d > 7) out.push({ key: `contract:${s.contract_end}:30`,
      subject: `Your electricity contract ends on ${fmt(s.contract_end)}`,
      text: `Your contract ends on ${fmt(s.contract_end)}. After that you are usually moved to the supplier's standard rate, which costs more. A new plan can be lined up now so there is no gap.${link}` });
    if (d <= 7 && d >= 0) out.push({ key: `contract:${s.contract_end}:7`,
      subject: `A week left on your electricity contract`,
      text: `Your contract ends on ${fmt(s.contract_end)}. If you haven't chosen a new plan, this is the week to do it.${link}` });
  }
  return out;
}

function fmt(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin' });
}

/**
 * What the quarterly suggestions are read into, and the rules for the summary
 * the app sends. Shared by api/advice.js and its tests; no network here.
 */
import { z } from 'zod';

export const AdviceSchema = z.object({
  items: z.array(z.object({
    title: z.string().describe('One short imperative line, e.g. "Run the dishwasher after 11pm".'),
    why: z.string().describe('One or two plain sentences that cite the figures in the summary this rests on.'),
    saving_eur: z.number().nullable().describe('Yearly saving in euro worked out from the summary, or null if it cannot be.'),
    effort: z.enum(['easy', 'some', 'big']),
  })).max(3),
});

export const ADVICE_PROMPT = `You advise Irish households on cutting their electricity costs.

You are given a JSON summary of one household: its home, current plan with unit rates in cent and time windows (24h clock), the cheapest plans for it, its use by hour of day over the last 90 days when available, a score, and what it has already done.

Give up to three suggestions for the next three months, most valuable first. Rules:
- Ground each one in the figures given. Quote the rates, hours or kWh it rests on.
- Never invent a price, plan, product or grant that is not in the summary.
- Work out saving_eur only from the summary's numbers (e.g. kWh moved × the rate difference); otherwise null.
- Do not repeat what the household has already done.
- If the household is already on the best plan with good timing, say fewer things rather than padding.
- Plain English, no jargon, no exclamation marks.`;

const MAX_BYTES = 12_000;

/** Request body check. Returns an error message, or null. */
export function checkSummary(body) {
  if (!body || typeof body !== 'object' || !body.summary || typeof body.summary !== 'object') return 'No summary was sent.';
  const raw = JSON.stringify(body.summary);
  if (raw.length > MAX_BYTES) return 'The summary is too large.';
  // Personal details have no place in it; refuse rather than forward them.
  if (/@|\beircode\b|\bmprn\b/i.test(raw)) return 'The summary contains personal details.';
  return null;
}

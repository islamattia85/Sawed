/**
 * POST /api/advice — this quarter's suggestions for one household.
 *
 * Body: { summary } (built by adviceSummary() in the app: plans, rates, use by
 * hour, score — no personal details). Reply: { advice: { items } } or
 * { error }. Nothing is stored here. Needs ANTHROPIC_API_KEY.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { guard, rateLimited, readBody } from './_server.js';
import { AdviceSchema, ADVICE_PROMPT, checkSummary } from './_advice.js';

export const config = { maxDuration: 60 };

const client = new Anthropic();

export default async function handler(req, res) {
  if (guard(req, res)) return;
  if (await rateLimited(req, res, 'advice', 10)) return;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Suggestions are not switched on yet.' });
  const body = readBody(req);
  const bad = checkSummary(body);
  if (bad) return res.status(400).json({ error: bad });

  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: 'medium', format: betaZodOutputFormat(AdviceSchema) },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: ADVICE_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(body.summary) }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return res.status(422).json({ error: 'Suggestions could not be worked out this time. Try again later.' });
    }
    return res.status(200).json({ advice: response.parsed_output });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Busy right now — try again in a minute.' });
    return res.status(502).json({ error: 'Suggestions are unavailable just now.' });
  }
}

/**
 * POST /api/extract-quote — read an installer's solar quote.
 *
 * Body: { media_type: "application/pdf" | "image/jpeg" | ..., data: <base64> }
 * Reply: { quote: <QuoteSchema, reconciled> } or { error: "<plain sentence>" }.
 *
 * The file goes to Claude and nowhere else: nothing is stored or logged here.
 * The reply is a draft for the person to confirm — the app never models a
 * quote it has not shown them first.
 *
 * Needs ANTHROPIC_API_KEY in the Vercel project's environment variables.
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { QuoteSchema, SYSTEM_PROMPT, checkUpload, reconcile } from './_quote.js';

export const config = { maxDuration: 60 };

// Only the app itself may spend the key. Browsers always send Origin on a
// cross-site POST, so this stops other sites; it is not a lock against a
// determined script, which Vercel's firewall rate limit covers.
const ALLOWED = [/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
if (process.env.APP_ORIGIN) ALLOWED.push(new RegExp(`^${process.env.APP_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

const client = new Anthropic();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED.some((r) => r.test(origin))) return res.status(403).json({ error: 'Not allowed.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Quote reading is not switched on yet.' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  const bad = checkUpload(body);
  if (bad) return res.status(400).json({ error: bad });

  const file = body.media_type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.data } }
    : { type: 'image', source: { type: 'base64', media_type: body.media_type, data: body.data } };

  try {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      output_config: { effort: 'medium', format: betaZodOutputFormat(QuoteSchema) },
      // If the model declines, the API retries on its default fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [file, { type: 'text', text: 'Extract this quote.' }] }],
    });

    if (response.stop_reason === 'refusal') return res.status(422).json({ error: 'This document could not be read as a quote.' });
    if (response.stop_reason === 'max_tokens' || !response.parsed_output) {
      return res.status(422).json({ error: 'The quote could not be read completely. Try a clearer copy, or enter it by hand.' });
    }
    const quote = reconcile(response.parsed_output);
    if (!quote.is_solar_quote) return res.status(422).json({ error: "That doesn't look like a solar or battery quote." });
    return res.status(200).json({ quote });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Busy right now — try again in a minute.' });
    if (err instanceof Anthropic.BadRequestError) return res.status(400).json({ error: 'That file could not be read. Try a PDF or a clear photo.' });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: 'Quote reading is unavailable just now.' });
    return res.status(500).json({ error: 'Something went wrong reading the quote.' });
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

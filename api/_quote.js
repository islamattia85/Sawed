/**
 * What a solar quote is read into, and the rules for trusting it.
 *
 * Shared by the endpoint (api/extract-quote.js) and its tests. Nothing here
 * calls the network. Files under api/ whose names start with "_" are not
 * deployed as routes.
 */

import { z } from 'zod';

/** A figure as the quote states it, with the words it was read from. */
const num = z.number().nullable();
const evidence = z.string().nullable()
  .describe('The exact words or table cell on the quote this was read from, verbatim and short. null if not stated.');

export const QuoteSchema = z.object({
  is_solar_quote: z.boolean()
    .describe('true only if the document is a quote or proposal for a solar PV and/or home battery installation.'),
  installer: z.string().nullable().describe('Installer company name, as printed.'),
  quote_date: z.string().nullable().describe('Date on the quote, ISO YYYY-MM-DD if it can be determined.'),

  panel_count: num.describe('Number of solar panels.'),
  panel_watts: num.describe('Rated power of ONE panel in watts (e.g. 440).'),
  panel_model: z.string().nullable(),
  system_kwp: num.describe('Total array size in kWp as stated.'),
  inverter_model: z.string().nullable(),
  inverter_kw: num,
  battery_kwh: num.describe('Usable battery capacity in kWh. 0 if the quote clearly has no battery; null if unclear.'),
  battery_model: z.string().nullable(),

  price_total_eur: num.describe('Total price for the installation INCLUDING VAT and BEFORE the SEAI grant is deducted.'),
  grant_eur: num.describe('SEAI grant amount stated on the quote (a positive number).'),
  price_after_grant_eur: num.describe('Amount payable after the grant, if stated.'),
  vat_included: z.boolean().nullable().describe('true if the stated price includes VAT.'),

  orientation: z.string().nullable().describe('Roof direction(s) the panels face, e.g. "south" or "east/west".'),
  roof_pitch_deg: num.describe('Roof or panel tilt in degrees, if stated.'),
  roof_faces: z.array(z.object({
    panels: num.describe('Panels on this roof face, as stated.'),
    orientation: z.string().nullable().describe('Direction this face points, as stated, e.g. "south-west".'),
    tilt_deg: num,
  })).nullable().describe('Only when the quote splits the panels across roof faces: one entry per face, as stated. null for a single face or when no split is stated.'),
  estimated_annual_kwh: num.describe("The installer's own estimate of yearly generation in kWh."),
  extras: z.array(z.string()).describe('Other items included: diverter, EV charger, bird mesh, scaffolding, etc.'),

  evidence: z.object({
    panel_count: evidence,
    panel_watts: evidence,
    battery_kwh: evidence,
    price_total_eur: evidence,
    grant_eur: evidence,
  }),
  warnings: z.array(z.string())
    .describe('Anything ambiguous or contradictory a homeowner should check, in one short plain sentence each.'),
});

export const SYSTEM_PROMPT = `You read Irish solar PV and battery installation quotes and extract the facts on them.

Rules:
- Report only what the document states. Never estimate, infer from typical values, or fill a gap: leave the field null and, if it matters, add a warning.
- Prices are in euro. price_total_eur is the full price including VAT, before the SEAI grant. If the quote only states a price after the grant and the grant, add them; say so in warnings.
- panel_watts is the rating of one panel; if only the total kWp and the count are given, leave panel_watts null.
- roof_faces: fill it only when the quote itself states panels on more than one roof face (e.g. "11 south-west, 11 south-east"). Never divide the panels yourself; if directions are given without counts, give each face with panels null.
- battery_kwh is usable capacity. If a battery is listed with only a model name, leave it null and warn.
- For each evidence field, copy the short piece of text the value came from, verbatim.
- Do not copy names, addresses, phone numbers, emails, MPRNs or signatures into any field. Installer company name is allowed.
- If the document is not a solar or battery quote, set is_solar_quote to false and leave everything else null or empty.`;

export const MAX_BYTES = 3_200_000;   // raw file; base64 adds a third, under Vercel's 4.5 MB body cap
export const MEDIA_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** Request body checks. Returns an error message, or null when acceptable. */
export function checkUpload(body) {
  if (!body || typeof body !== 'object') return 'No file was sent.';
  const { media_type: mt, data } = body;
  if (!MEDIA_TYPES.includes(mt)) return 'Send a PDF, or a photo (JPEG, PNG or WebP).';
  if (typeof data !== 'string' || !data.length) return 'The file was empty.';
  if (!/^[A-Za-z0-9+/]+=*$/.test(data)) return 'The file could not be read.';
  if (Math.floor(data.length * 3 / 4) > MAX_BYTES) return 'That file is too large. Under 3 MB, please — a photo of each page works too.';
  return null;
}

/**
 * Cross-check what was read, so the app never models a quote it misread.
 * Adds warnings; never invents a value.
 */
export function reconcile(q) {
  const out = { ...q, warnings: [...(q.warnings || [])] };
  if (out.panel_count && out.panel_watts && out.system_kwp) {
    const kwp = out.panel_count * out.panel_watts / 1000;
    if (Math.abs(kwp - out.system_kwp) > 0.15) {
      out.warnings.push(`The quote says ${out.system_kwp} kWp, but ${out.panel_count} × ${out.panel_watts} W is ${kwp.toFixed(2)} kWp.`);
    }
  }
  if (out.panel_count && !out.panel_watts && out.system_kwp) {
    const w = Math.round(out.system_kwp * 1000 / out.panel_count);
    if (w >= 250 && w <= 700) { out.panel_watts = w; out.warnings.push(`Panel rating worked out from ${out.system_kwp} kWp ÷ ${out.panel_count} panels.`); }
  }
  if (out.price_total_eur && out.grant_eur && out.price_after_grant_eur
      && Math.abs(out.price_total_eur - out.grant_eur - out.price_after_grant_eur) > 5) {
    out.warnings.push('The total, grant and amount after grant on the quote do not add up.');
  }
  if (out.price_total_eur != null && (out.price_total_eur < 1500 || out.price_total_eur > 60000)) {
    out.warnings.push(`€${out.price_total_eur} is outside the range of a home installation — check the price read.`);
  }
  if (out.panel_count != null && (out.panel_count < 1 || out.panel_count > 60)) {
    out.warnings.push(`${out.panel_count} panels is unusual for a home — check the count read.`);
  }
  if (out.vat_included === false) out.warnings.push('The price appears to exclude VAT; the app compares prices including VAT.');
  return out;
}

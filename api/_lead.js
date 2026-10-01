/**
 * Quote requests: what a valid one looks like, and how good a lead it is.
 * Pure — shared by api/lead.js and its tests.
 */

export const COUNTIES = ['Carlow', 'Cavan', 'Clare', 'Cork', 'Donegal', 'Dublin', 'Galway', 'Kerry', 'Kildare',
  'Kilkenny', 'Laois', 'Leitrim', 'Limerick', 'Longford', 'Louth', 'Mayo', 'Meath', 'Monaghan', 'Offaly',
  'Roscommon', 'Sligo', 'Tipperary', 'Waterford', 'Westmeath', 'Wexford', 'Wicklow'];

export const TIMELINES = ['asap', '3m', '6m', '12m', 'browsing'];

/** The words the homeowner agreed to. Stored with the lead, versioned. */
export const CONSENT_TEXT_V1 =
  'I agree that Peakless may share my name, contact details, county and the system modelled here with up to three ' +
  'SEAI-registered installers so they can contact me with a quote. (consent v1)';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clampNum = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

/** Returns { lead } ready to store, or { error } in plain words. */
export function validateLead(b) {
  if (!b || typeof b !== 'object') return { error: 'Nothing was sent.' };
  const email = String(b.email || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) return { error: 'Please enter a valid email address.' };
  if (!COUNTIES.includes(b.county)) return { error: 'Please choose your county.' };
  if (b.consent_share !== true) return { error: 'We need your agreement to pass your details to installers.' };
  const phone = b.phone ? String(b.phone).replace(/[^\d+ ]/g, '').slice(0, 20) : null;
  const s = b.spec || {};
  const spec = {
    panels: clampNum(s.panels, 0, 80), kwp: clampNum(s.kwp, 0, 40), battery_kwh: clampNum(s.battery_kwh, 0, 60),
    annual_kwh: clampNum(s.annual_kwh, 0, 60000), ev: !!s.ev, heating: String(s.heating || '').slice(0, 20),
    payback_years: clampNum(s.payback_years, 0, 60), annual_benefit_eur: clampNum(s.annual_benefit_eur, 0, 20000),
    has_solar_now: !!s.has_solar_now, uploaded_quote: !!s.uploaded_quote,
  };
  return {
    lead: {
      name: b.name ? String(b.name).trim().slice(0, 100) : null,
      email, phone,
      county: b.county,
      eircode_area: b.eircode_area ? String(b.eircode_area).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) : null,
      timeline: TIMELINES.includes(b.timeline) ? b.timeline : 'browsing',
      spec,
      consent_share: true,
      consent_text: CONSENT_TEXT_V1,
      dedupe_key: `${email}|${b.county}`,
    },
  };
}

/**
 * 0–100: how likely this turns into an installation. Installers pay by lead,
 * so a score lets price and routing reflect quality, and it is shown to them.
 */
export function scoreLead(lead) {
  const s = lead.spec || {};
  let score = 20;
  score += { asap: 30, '3m': 25, '6m': 15, '12m': 8, browsing: 0 }[lead.timeline] ?? 0;
  if (lead.phone) score += 10;
  if (lead.name) score += 5;
  if (s.kwp >= 3) score += 10;
  if (s.battery_kwh > 0) score += 5;
  if (s.payback_years && s.payback_years <= 9) score += 10;
  if (s.uploaded_quote) score += 10;          // already comparing real quotes
  if (s.has_solar_now) score -= 15;           // an upgrade, not a new system
  return Math.max(0, Math.min(100, score));
}

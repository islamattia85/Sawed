import { describe, it, expect } from 'vitest';
import { validateLead, scoreLead, CONSENT_TEXT_V1 } from '../../api/_lead.js';
import leadHandler from '../../api/lead.js';
import eventHandler from '../../api/event.js';
import { FEATURES } from '../../src/features.js';

const ok = { email: 'Home@Example.ie', county: 'Cork', consent_share: true, timeline: '3m',
  spec: { panels: 12, kwp: 5.28, battery_kwh: 5, payback_years: 7.5 } };

describe('quote requests', () => {
  it('accepts a complete request and normalises it', () => {
    const { lead, error } = validateLead(ok);
    expect(error).toBeUndefined();
    expect(lead.email).toBe('home@example.ie');
    expect(lead.dedupe_key).toBe('home@example.ie|Cork');
    expect(lead.consent_text).toBe(CONSENT_TEXT_V1);
  });
  it('refuses without consent, county or a valid email', () => {
    expect(validateLead({ ...ok, consent_share: false }).error).toMatch(/agreement/);
    expect(validateLead({ ...ok, county: 'Atlantis' }).error).toMatch(/county/);
    expect(validateLead({ ...ok, email: 'nope' }).error).toMatch(/email/);
  });
  it('clamps nonsense in the spec rather than passing it to installers', () => {
    const { lead } = validateLead({ ...ok, spec: { panels: 9999, kwp: -3 } });
    expect(lead.spec.panels).toBe(80);
    expect(lead.spec.kwp).toBe(0);
  });
  it('scores a ready buyer above someone browsing', () => {
    const ready = validateLead({ ...ok, timeline: 'asap', phone: '087 123 4567' }).lead;
    const browsing = validateLead({ ...ok, timeline: 'browsing' }).lead;
    expect(scoreLead(ready)).toBeGreaterThan(scoreLead(browsing));
    expect(scoreLead(ready)).toBeLessThanOrEqual(100);
  });
});

function call(handler: any, req: any) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const res: any = { status(c: number) { this.c = c; return this; }, json(b: any) { resolve({ status: this.c, body: b }); } };
    handler({ ...req, headers: { origin: 'http://localhost:5173', ...req.headers } }, res);
  });
}

describe('endpoint guards (no network)', () => {
  it('lead: switched off for the first launch, so nothing is accepted', async () => {
    expect(FEATURES.installerQuotes).toBe(false);
    expect((await call(leadHandler, { method: 'POST', body: ok })).status).toBe(404);
  });
  it('lead, once switched on: POST only, own origin only, says so when the database is not configured', async () => {
    FEATURES.installerQuotes = true;
    expect((await call(leadHandler, { method: 'GET' })).status).toBe(405);
    expect((await call(leadHandler, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect((await call(leadHandler, { method: 'POST', body: ok })).status).toBe(503);
    if (k) process.env.SUPABASE_SERVICE_ROLE_KEY = k;
    FEATURES.installerQuotes = false;
  });
  it('event: only known event names are counted', async () => {
    expect((await call(eventHandler, { method: 'POST', body: { name: 'anything' } })).status).toBe(400);
  });
});

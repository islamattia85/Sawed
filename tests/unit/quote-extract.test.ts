import { describe, it, expect } from 'vitest';
import { checkUpload, reconcile, QuoteSchema, MAX_BYTES } from '../../api/_quote.js';
import handler from '../../api/extract-quote.js';

const base = {
  is_solar_quote: true, installer: 'Acme Solar', quote_date: null, panel_count: 12, panel_watts: 440,
  panel_model: null, system_kwp: 5.28, inverter_model: null, inverter_kw: null, battery_kwh: 5, battery_model: null,
  price_total_eur: 11800, grant_eur: 1800, price_after_grant_eur: 10000, vat_included: true, orientation: 'south',
  roof_pitch_deg: null, estimated_annual_kwh: null, extras: [],
  evidence: { panel_count: '12 x 440W', panel_watts: '440W', battery_kwh: '5kWh', price_total_eur: '€11,800', grant_eur: '€1,800' },
  warnings: [],
};

describe('upload checks', () => {
  it('accepts a PDF or a photo', () => {
    expect(checkUpload({ media_type: 'application/pdf', data: 'JVBERi0x' })).toBeNull();
    expect(checkUpload({ media_type: 'image/jpeg', data: 'AAAA' })).toBeNull();
  });
  it('refuses other types, empty, non-base64, and oversize files', () => {
    expect(checkUpload({ media_type: 'text/html', data: 'AAAA' })).toMatch(/PDF/);
    expect(checkUpload({ media_type: 'application/pdf', data: '' })).toMatch(/empty/);
    expect(checkUpload({ media_type: 'application/pdf', data: '<script>' })).toMatch(/read/);
    expect(checkUpload({ media_type: 'application/pdf', data: 'A'.repeat(Math.ceil(MAX_BYTES * 4 / 3) + 8) })).toMatch(/large/);
  });
});

describe('reconcile', () => {
  it('passes a consistent quote through unchanged', () => {
    expect(QuoteSchema.parse(base)).toBeTruthy();
    expect(reconcile(base).warnings).toEqual([]);
  });
  it('flags kWp that does not match panels × watts, and prices that do not add up', () => {
    const r = reconcile({ ...base, system_kwp: 6.5, price_after_grant_eur: 9000 });
    expect(r.warnings.join(' ')).toMatch(/6.5 kWp/);
    expect(r.warnings.join(' ')).toMatch(/do not add up/);
  });
  it('works out the panel rating only when count and kWp are both stated', () => {
    expect(reconcile({ ...base, panel_watts: null }).panel_watts).toBe(440);
    expect(reconcile({ ...base, panel_watts: null, system_kwp: null }).panel_watts).toBeNull();
  });
  it('never invents a price', () => {
    expect(reconcile({ ...base, price_total_eur: null }).price_total_eur).toBeNull();
  });
});

function call(req: any) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const res: any = { status(c: number) { this.c = c; return this; }, json(b: any) { resolve({ status: this.c, body: b }); } };
    handler({ headers: {}, ...req }, res);
  });
}

describe('endpoint guards (no network)', () => {
  it('only accepts POST', async () => { expect((await call({ method: 'GET' })).status).toBe(405); });
  it('refuses other websites', async () => {
    expect((await call({ method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('says plainly when no key is configured', async () => {
    const k = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r = await call({ method: 'POST', body: { media_type: 'application/pdf', data: 'JVBE' } });
    if (k) process.env.ANTHROPIC_API_KEY = k;
    expect(r.status).toBe(503);
  });
});

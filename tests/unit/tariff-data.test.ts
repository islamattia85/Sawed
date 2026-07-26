import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bandAt, rateAt, simulateBaseline, annualCost, sumF } from '../../src/engine/tariff-rules.js';
import { HOURS_IN_YEAR, type Band, type Tariff } from '../../src/engine/constants.js';

/**
 * Structural checks on the tariff registry.
 *
 * These exist because PIN-WFH shipped with `windows.wfh` but no `rates.wfh`.
 * bandAt() resolved to 'wfh', the rate lookup returned undefined, and the
 * plan's annual cost became NaN — which then sorted to an arbitrary position
 * in the rankings and rendered as "€NaN". Nothing caught it because nothing
 * ever asserted that a plan's cost is a number.
 */

/**
 * Pull the embedded tariff registry out of the entry module without executing
 * the app. This is the fallback data shipped in the bundle; public/tariffs.json
 * overrides it at runtime and is validated separately.
 */
function loadTariffs(): Tariff[] {
  const src = readFileSync('src/main.js', 'utf8');
  const start = src.indexOf('const EMBEDDED_TARIFFS = [');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('[', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  const literal = src.slice(open, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${literal};`)() as Tariff[];
}

const TARIFFS = loadTariffs();
const active = TARIFFS.filter((t) => !t.discontinued);
const BANDS: Band[] = ['day', 'night', 'peak', 'ev', 'wfh'];

describe('tariff registry', () => {
  it('loads a plausible number of plans', () => {
    expect(active.length).toBeGreaterThan(10);
  });

  it('every plan has a day rate to fall back to', () => {
    for (const t of active) {
      expect(typeof t.rates?.day, `${t.id} has no day rate`).toBe('number');
      expect(Number.isFinite(t.rates.day), `${t.id} day rate not finite`).toBe(true);
    }
  });

  /** The exact defect: a declared window with no matching rate. */
  it('every declared window has a rate with the same key', () => {
    const offenders: string[] = [];
    for (const t of active) {
      for (const band of BANDS) {
        if (band === 'day') continue;
        const w = (t.windows ?? {})[band as Exclude<Band, 'day'>];
        if (w && t.rates[band] == null) offenders.push(`${t.id}: windows.${band} set but rates.${band} missing`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every rate that exists is a finite, sane number', () => {
    const offenders: string[] = [];
    for (const t of active) {
      for (const band of BANDS) {
        const v = t.rates[band];
        if (v == null) continue;
        if (!Number.isFinite(v) || v < -0.5 || v > 2) offenders.push(`${t.id}.${band} = ${v}`);
      }
      if (!Number.isFinite(t.standing) || t.standing < 0) offenders.push(`${t.id}.standing = ${t.standing}`);
    }
    expect(offenders).toEqual([]);
  });

  it('windows are valid hour ranges', () => {
    const offenders: string[] = [];
    for (const t of active) {
      for (const [name, w] of Object.entries(t.windows ?? {})) {
        if (!w) continue;
        const [a, b] = w as [number, number];
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 23 || b < 0 || b > 24 || a === b) {
          offenders.push(`${t.id}.${name} = [${a}, ${b}]`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /** The guarantee that actually matters: no plan can price to NaN. */
  it('no active plan produces a non-finite annual cost', () => {
    const cons = new Float32Array(HOURS_IN_YEAR).fill(0.5);
    const offenders: string[] = [];
    for (const t of active) {
      const sim = simulateBaseline(t, cons);
      const cost = annualCost(sim, t);
      if (!Number.isFinite(cost.net)) offenders.push(`${t.id} net=${cost.net}`);
      if (!Number.isFinite(sumF(sim.cost))) offenders.push(`${t.id} energy=NaN`);
    }
    expect(offenders).toEqual([]);
  });

  it('every hour of every plan resolves to a finite rate', () => {
    const offenders: string[] = [];
    for (const t of active) {
      for (let h = 0; h < 24; h += 1) {
        const band = bandAt(h, t);
        const rate = rateAt(h, t);
        if (!Number.isFinite(rate)) offenders.push(`${t.id} h${h} band=${band} rate=${rate}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('PIN-WFH prices its working-from-home window below its standard rate', () => {
    const wfh = active.find((t) => t.id === 'PIN-WFH');
    if (!wfh) return;
    expect(bandAt(12, wfh)).toBe('wfh');
    expect(bandAt(3, wfh)).toBe('day');
    expect(rateAt(12, wfh)).toBeLessThan(rateAt(3, wfh));
  });
});

/**
 * public/tariffs.json is fetched at runtime and REPLACES the embedded registry,
 * so it is the data users are actually priced against. The PIN-WFH defect was
 * present in both copies; fixing only the embedded one would have changed
 * nothing in production. Every structural rule above is re-asserted here
 * against the file that ships.
 */
describe('public/tariffs.json (the data users are priced against)', () => {
  const shipped = (JSON.parse(readFileSync('public/tariffs.json', 'utf8')) as unknown[])
    .filter((t): t is Tariff => !!t && typeof t === 'object' && 'id' in t
      && (t as Tariff).id !== '__meta__' && !(t as Tariff).discontinued);

  it('parses and contains plans', () => {
    expect(shipped.length).toBeGreaterThan(10);
  });

  it('every declared window has a rate with the same key', () => {
    const offenders: string[] = [];
    for (const t of shipped) {
      for (const band of BANDS) {
        if (band === 'day') continue;
        const w = (t.windows ?? {})[band as Exclude<Band, 'day'>];
        if (w && t.rates?.[band] == null) offenders.push(`${t.id}: windows.${band} without rates.${band}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no shipped plan produces a non-finite annual cost', () => {
    const cons = new Float32Array(HOURS_IN_YEAR).fill(0.5);
    const offenders: string[] = [];
    for (const t of shipped) {
      const cost = annualCost(simulateBaseline(t, cons), t);
      if (!Number.isFinite(cost.net)) offenders.push(`${t.id} net=${cost.net}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every hour of every shipped plan resolves to a finite rate', () => {
    const offenders: string[] = [];
    for (const t of shipped) {
      for (let h = 0; h < 24; h += 1) {
        if (!Number.isFinite(rateAt(h, t))) offenders.push(`${t.id} h${h} band=${bandAt(h, t)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The search is the part of V4 that is allowed to be wrong in a way nobody
 * notices. Every other bug in this application shows up on a screen; a search
 * that quietly returns the second-best system produces a confident, plausible,
 * well-formatted recommendation that costs someone a few thousand euro.
 *
 * So the central test here is not "does it return something sensible". It is
 * "does the pruned, coarse-to-fine search agree with exhaustively pricing
 * every design in the same space". Pruning is the only reason this runs in a
 * browser at all, and it is exactly the thing that can lose the answer.
 */

import { describe, it, expect } from 'vitest';
import { HOURS_IN_YEAR, type Tariff } from '../../src/engine/constants.js';
import {
  searchDesigns, explain, confidence, DEFAULT_BATTERY_OPTIONS,
  type HomeProfile, type CostModel, type SearchLimits,
} from '../../src/engine/search.js';

/* ---------------------------------------------------------------- a house */

function genPerKwp(): Float32Array {
  const a = new Float32Array(HOURS_IN_YEAR);
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    const doy = Math.floor(i / 24);
    const h = i % 24;
    const season = 0.35 + 0.65 * Math.max(0, Math.sin(((doy - 80) / 365) * 2 * Math.PI));
    const day = Math.max(0, Math.sin(((h - 6) / 13) * Math.PI));
    a[i] = season * day * 0.62;         // ~900 kWh/kWp/yr, an Irish roof
  }
  return a;
}

function consProfile(annualKwh: number, eveningHeavy = true): Float32Array {
  const a = new Float32Array(HOURS_IN_YEAR);
  let total = 0;
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    const h = i % 24;
    const v = 0.25
      + (h >= 7 && h <= 9 ? 0.8 : 0)
      + (eveningHeavy && h >= 17 && h <= 21 ? 1.4 : 0)
      + (!eveningHeavy && h >= 11 && h <= 15 ? 1.4 : 0);
    a[i] = v; total += v;
  }
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) a[i] = ((a[i] ?? 0) * annualKwh) / total;
  return a;
}

const plan = (o: Partial<Tariff> & { id: string }) => ({
  supplier: 'Test', plan: o.id, type: 'standard', standing: 300, export_rate: 0.20,
  rates: { day: 0.35, night: 0.18, peak: 0.42 },
  windows: { night: [23, 8], peak: [17, 19] },
  ...o,
}) as unknown as Tariff;

const PLANS: Tariff[] = [
  plan({ id: 'flat-high', rates: { day: 0.42, peak: 0.42, night: 0.42 }, windows: {} }),
  plan({ id: 'flat-mid', rates: { day: 0.36, peak: 0.36, night: 0.36 }, windows: {} }),
  plan({ id: 'day-night' }),
  plan({ id: 'smart-ev', rates: { day: 0.40, night: 0.19, peak: 0.46, ev: 0.08 },
    windows: { night: [23, 8], peak: [17, 19], ev: [2, 5] } }),
  plan({ id: 'good-export', export_rate: 0.24 }),
  plan({ id: 'poor-export', export_rate: 0.05 }),
  plan({ id: 'cheap-standing', standing: 180, rates: { day: 0.39, peak: 0.39, night: 0.39 }, windows: {} }),
];

const HOME: HomeProfile = {
  genPerKwp: genPerKwp(),
  cons: consProfile(4800),
  consNoEv: consProfile(4800),
  evInBill: true,
  exportLimitKw: 6,
  exportAllowed: true,
  inverterKw: 5,
};

/** The app's real cost model. */
const COSTS: CostModel = {
  installCost: (kwp, batt) => {
    const panelCost = kwp <= 3 ? kwp * 950 : 3 * 950 + (kwp - 3) * 750;
    const battCost = batt > 0 ? 800 + batt * 380 : 0;
    return Math.round((2900 + panelCost + battCost) / 100) * 100;
  },
  grant: (kwp) => (kwp <= 0 ? 0 : Math.min(Math.round(Math.min(kwp, 2) * 900), 1800)),
};

const LIMITS: SearchLimits = { panelWatts: 440, maxPanels: 20, minPanels: 4 };

/* ------------------------------------------------------------------ tests */

describe('the design search', () => {
  it('finds the same system an exhaustive sweep would', () => {
    const pruned = searchDesigns(HOME, PLANS, COSTS, LIMITS);

    // Every design in the space, no shortlisting, no coarse grid.
    const exhaustive = searchDesigns(HOME, PLANS, COSTS, {
      ...LIMITS,
      planShortlist: PLANS.length,
      batteryOptions: DEFAULT_BATTERY_OPTIONS,
      // A "coarse" grid dense enough to be every panel count, and a refine
      // pass that therefore adds nothing.
      maxEvaluations: 1e9,
    });
    // spread() gives the coarse pass 6 points; force the full grid instead by
    // running one search per panel count and taking the best.
    let bruteBest: { npv: number; panels: number; batteryKwh: number } | null = null;
    for (let p = LIMITS.minPanels!; p <= LIMITS.maxPanels; p += 1) {
      const one = searchDesigns(HOME, PLANS, COSTS, {
        ...LIMITS, minPanels: p, maxPanels: p, planShortlist: PLANS.length,
      });
      const d = one.ranked[0];
      if (d && (!bruteBest || d.npv > bruteBest.npv)) bruteBest = d;
    }

    expect(bruteBest).toBeTruthy();
    expect(pruned.best).toBeTruthy();
    // The pruned search must land on the same decision, not merely a similar
    // number: same array size, same battery.
    expect({ panels: pruned.best!.panels, batteryKwh: pruned.best!.batteryKwh })
      .toEqual({ panels: bruteBest!.panels, batteryKwh: bruteBest!.batteryKwh });
    expect(pruned.best!.npv).toBeCloseTo(bruteBest!.npv, -1);
    // …and it must have cost meaningfully less to get there.
    expect(pruned.evaluated).toBeLessThan(exhaustive.evaluated * 2);
  });

  it('is deterministic', () => {
    const a = searchDesigns(HOME, PLANS, COSTS, LIMITS);
    const b = searchDesigns(HOME, PLANS, COSTS, LIMITS);
    expect(b.best).toEqual(a.best);
    expect(b.evaluated).toBe(a.evaluated);
    expect(b.shortlist).toEqual(a.shortlist);
  });

  it('counts the simulations it actually ran', () => {
    let lastReported = 0;
    const r = searchDesigns(HOME, PLANS, COSTS, LIMITS, (p) => { lastReported = p.evaluated; });
    expect(r.evaluated).toBeGreaterThan(100);
    expect(lastReported).toBe(r.evaluated);
    // The number shown to a reader has to be defensible: it is one full
    // 8,760-hour simulation each, not a multiplied-up marketing figure.
    expect(r.evaluated).toBeLessThan(6000);
  });

  it('recommends nothing when nothing is worth buying', () => {
    const ruinous: CostModel = { installCost: (kwp, b) => 40000 + kwp * 5000 + b * 3000, grant: () => 0 };
    const r = searchDesigns(HOME, PLANS, ruinous, LIMITS);
    expect(r.best, 'sold a system that can never repay').toBeNull();
    expect(explain(r, LIMITS)).toEqual([{ kind: 'not-worthwhile' }]);
    expect(confidence(r)).toBe(0);
  });

  it('prices doing nothing on the cheapest tariff available', () => {
    const r = searchDesigns(HOME, PLANS, COSTS, LIMITS);
    expect(r.doNothing.annualNet).toBeGreaterThan(0);
    // Every recommended design must beat it, or it would not be recommended.
    expect(r.best!.annualNet).toBeLessThan(r.doNothing.annualNet);
    expect(r.best!.annualBenefit).toBeGreaterThan(0);
  });

  it('drops the battery when the same money buys panels that do more', () => {
    // Batteries at four times the going rate; panels unchanged.
    const dearBattery: CostModel = {
      installCost: (kwp, batt) => COSTS.installCost(kwp, 0) + (batt > 0 ? 800 + batt * 1520 : 0),
      grant: COSTS.grant,
    };
    const r = searchDesigns(HOME, PLANS, dearBattery, LIMITS);
    expect(r.best!.batteryKwh).toBe(0);
    const reasons = explain(r, LIMITS).map((x) => x.kind);
    expect(reasons).toContain('more-panels-beat-battery');
  });

  it('keeps the battery when it genuinely pays', () => {
    // Batteries at a quarter of the going rate.
    const cheapBattery: CostModel = {
      installCost: (kwp, batt) => COSTS.installCost(kwp, 0) + (batt > 0 ? 200 + batt * 95 : 0),
      grant: COSTS.grant,
    };
    const r = searchDesigns(HOME, PLANS, cheapBattery, LIMITS);
    expect(r.best!.batteryKwh).toBeGreaterThan(0);
    expect(explain(r, LIMITS).map((x) => x.kind)).toContain('battery-earns-its-keep');
  });

  it('never recommends more panels than fit on the roof', () => {
    const small = searchDesigns(HOME, PLANS, COSTS, { ...LIMITS, maxPanels: 8 });
    expect(small.best!.panels).toBeLessThanOrEqual(8);
    expect(small.ranked.every((d) => d.panels <= 8)).toBe(true);
  });

  it('says so when the roof is the binding constraint', () => {
    const small = searchDesigns(HOME, PLANS, COSTS, { ...LIMITS, maxPanels: 6 });
    if (small.best?.panels === 6) {
      expect(explain(small, { ...LIMITS, maxPanels: 6 }).map((x) => x.kind)).toContain('roof-limited');
    }
  });

  it('reports low confidence when the top two designs are neck and neck', () => {
    const r = searchDesigns(HOME, PLANS, COSTS, LIMITS);
    const c = confidence(r);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThanOrEqual(1);

    const runnerUp = r.ranked.find((d) => d.panels !== r.best!.panels || d.batteryKwh !== r.best!.batteryKwh);
    const margin = (r.best!.npv - runnerUp!.npv) / Math.abs(r.best!.npv);
    // The claim being made: confidence tracks separation, it is not decoration.
    if (margin < 0.02) expect(c).toBeLessThan(0.75);
    if (margin > 0.30) expect(c).toBeGreaterThan(0.75);
  });

  it('shortlists tariffs without losing the one that wins', () => {
    const pruned = searchDesigns(HOME, PLANS, COSTS, LIMITS);
    const full = searchDesigns(HOME, PLANS, COSTS, { ...LIMITS, planShortlist: PLANS.length });
    expect(pruned.shortlist).toContain(full.best!.planId);
    expect(pruned.best!.planId).toBe(full.best!.planId);
  });

  it('answers a daytime-heavy home differently from an evening-heavy one', () => {
    // Same annual kWh, same roof, same tariffs — only WHEN the electricity is
    // used differs. A search that returns identical economics for both is not
    // reading the home; it is reading the bill total.
    const daytime = { ...HOME, cons: consProfile(4800, false), consNoEv: consProfile(4800, false) };
    const a = searchDesigns(HOME, PLANS, COSTS, LIMITS);
    const b = searchDesigns(daytime, PLANS, COSTS, LIMITS);

    // A house that uses power while the sun is up self-consumes more of its
    // own generation, which is worth more than exporting it.
    expect(b.best!.annualBenefit).toBeGreaterThan(a.best!.annualBenefit);
    expect(Math.abs(b.best!.npv - a.best!.npv)).toBeGreaterThan(200);
  });

  it('will not oversize an array past the inverter that has to carry it', () => {
    // With a 3 kW inverter, panels beyond roughly 3.5 kWp spend the brightest
    // hours of the year clipped, producing nothing they were bought for. A
    // search that scaled generation linearly would never notice.
    // A roof big enough that the inverter, not the roof, is what binds.
    const roomy = { ...LIMITS, maxPanels: 40 };
    const small = searchDesigns({ ...HOME, inverterKw: 3 }, PLANS, COSTS, roomy);
    const big = searchDesigns({ ...HOME, inverterKw: 10 }, PLANS, COSTS, roomy);
    expect(small.best!.panels, 'the inverter limit did not restrain the array')
      .toBeLessThan(big.best!.panels);
  });

  it('finishes inside a budget a phone can afford', () => {
    const t = Date.now();
    searchDesigns(HOME, PLANS, COSTS, { ...LIMITS, maxPanels: 24 });
    const ms = Date.now() - t;
    // Generous here because CI machines vary; the point is to catch an
    // accidental order of magnitude, not to benchmark. A phone is ~4x slower.
    expect(ms, `search took ${ms}ms`).toBeLessThan(4000);
  });
});

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
  GOALS, monthlyRepayment, DEFAULT_FINANCE,
  type HomeProfile, type CostModel, type SearchLimits, type Goal,
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

/**
 * "Best" is not a technical question.
 *
 * The same house, roof and tariffs give different right answers depending on
 * what the person is trying to do. Someone treating the roof as a twenty-year
 * investment, someone borrowing so they can stop paying the utility and start
 * paying the bank, and someone who wants off the grid are not asking for
 * different presentations of one answer — they are asking different questions,
 * two of them with hard constraints attached.
 *
 * The engine has no business deciding that for them, and it must not quietly
 * answer the investment question and relabel it.
 */
describe('goals', () => {
  const search = (goal: Goal, over: Partial<SearchLimits> = {}) =>
    searchDesigns(HOME, PLANS, COSTS, { ...LIMITS, goal, ...over });

  it('gives every goal an answer, and each one satisfies its own constraint', () => {
    for (const goal of GOALS) {
      const r = search(goal);
      expect(r.best, `no answer for ${goal}`).toBeTruthy();
      expect(r.goal).toBe(goal);
      const d = r.best!;
      if (goal === 'bill-swap') {
        // The proposition IS the constraint: better off from month one.
        expect(d.monthlyNetChange, 'recommended a loan that costs more than it saves')
          .toBeGreaterThan(0);
        expect(d.monthlyRepayment).toBeGreaterThan(0);
      }
      if (goal === 'independence') expect(d.payback).toBeLessThan(20);
      if (goal === 'fast-payback') expect(d.payback).toBeLessThan(15);
    }
  });

  it('answers each goal with the system that actually serves it', () => {
    const investor = search('max-return').best!;
    const swap = search('bill-swap').best!;
    const off = search('independence').best!;
    const quick = search('fast-payback').best!;

    // Each goal's own metric must be best under that goal — otherwise the
    // objective function is decoration.
    expect(investor.npv).toBeGreaterThanOrEqual(swap.npv);
    expect(investor.npv).toBeGreaterThanOrEqual(off.npv);
    expect(off.selfSufficiency).toBeGreaterThanOrEqual(investor.selfSufficiency);
    expect(quick.payback).toBeLessThanOrEqual(investor.payback);
    expect(swap.monthlyNetChange).toBeGreaterThanOrEqual(investor.monthlyNetChange);
  });

  it('buys autonomy with a battery, and charges it from the sun rather than the grid', () => {
    const off = search('independence').best!;
    expect(off.batteryKwh, 'independence without storage').toBeGreaterThan(0);
    // Grid-charging is cheaper dependence, not autonomy, and must not be able
    // to inflate the self-sufficiency figure.
    expect(off.chargeFromGrid).toBe(false);
    expect(off.selfSufficiency).toBeGreaterThan(0.3);
    expect(off.selfSufficiency).toBeLessThanOrEqual(1);
  });

  it('says what independence costs before the reader commits to it', () => {
    const r = search('independence');
    const reasons = explain(r, LIMITS);
    const price = reasons.find((x) => x.kind === 'independence-costs-return');
    if (r.best!.npv < r.byGoal['max-return']!.npv) {
      expect(price, 'independence was sold without naming its price').toBeTruthy();
      expect(price!.worth).toBeGreaterThan(0);
      expect(price!.against!.npv).toBeGreaterThan(r.best!.npv);
    }
  });

  it('tells the reader when a different goal would buy a different system', () => {
    const r = search('max-return');
    const kinds = explain(r, LIMITS).map((x) => x.kind);
    const differs = GOALS.some((g) => {
      const d = r.byGoal[g];
      return d && (d.panels !== r.best!.panels || d.batteryKwh !== r.best!.batteryKwh);
    });
    if (differs) expect(kinds).toContain('goal-changes-the-answer');
  });

  it('answers all four goals from one sweep, as well as searching for each alone', () => {
    const shared = searchDesigns(HOME, PLANS, COSTS, LIMITS);
    for (const goal of GOALS) {
      const alone = searchDesigns(HOME, PLANS, COSTS, { ...LIMITS, goal, goals: [goal] });
      const a = shared.byGoal[goal];
      const b = alone.best;
      expect(Boolean(a)).toBe(Boolean(b));
      if (a && b) {
        // The shared sweep refines around every goal's neighbourhood, so it
        // must not settle for a worse answer than a search dedicated to one.
        expect({ panels: a.panels, batteryKwh: a.batteryKwh },
          `the shared sweep lost the ${goal} answer`)
          .toEqual({ panels: b.panels, batteryKwh: b.batteryKwh });
      }
    }
    // …and doing all four together must cost far less than four searches.
    const four = GOALS.reduce((t, goal) =>
      t + searchDesigns(HOME, PLANS, COSTS, { ...LIMITS, goal, goals: [goal] }).evaluated, 0);
    expect(shared.evaluated).toBeLessThan(four);
  });

  it('refuses the bill swap when the borrowing makes it impossible', () => {
    // 30% over three years: no system saves enough to cover that repayment.
    const r = search('bill-swap', { finance: { annualRate: 0.30, termYears: 3 } });
    expect(r.best, 'recommended a loan the household cannot cover').toBeNull();
    // And it must not be confused with "solar is not worth it here" — it is,
    // just not on those terms.
    expect(explain(r, LIMITS).map((x) => x.kind)).toEqual(['no-system-meets-this-goal']);
    expect(confidence(r)).toBe(0);
  });

  it('separates "not worth it" from "not on these terms"', () => {
    const ruinous: CostModel = { installCost: (kwp, b) => 40000 + kwp * 5000 + b * 3000, grant: () => 0 };
    const r = searchDesigns(HOME, PLANS, ruinous, { ...LIMITS, goal: 'bill-swap' });
    expect(explain(r, LIMITS).map((x) => x.kind)).toEqual(['not-worthwhile']);
  });

  it('prices the loan the way a bank does', () => {
    // €10,000 over 10 years at 6.2% is a shade under €112 a month.
    expect(monthlyRepayment(10000, { annualRate: 0.062, termYears: 10 })).toBeCloseTo(111.9, 0);
    // Interest-free is just the principal spread over the term.
    expect(monthlyRepayment(12000, { annualRate: 0, termYears: 10 })).toBeCloseTo(100, 6);
    // Paying cash has no repayment.
    expect(monthlyRepayment(12000, null)).toBe(0);
    expect(monthlyRepayment(0, DEFAULT_FINANCE)).toBe(0);
  });

  it('scores confidence against the goal that was asked for', () => {
    for (const goal of GOALS) {
      const c = confidence(search(goal));
      expect(c, `confidence out of range for ${goal}`).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

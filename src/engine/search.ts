/**
 * What SHOULD you install?
 *
 * Everything else in this engine answers "what if I install this?" — the
 * reader picks a system, the simulator prices it. That is a laboratory. This
 * module inverts it: given a home, it searches the space of systems and
 * returns the one that is actually worth buying, with the runners-up and the
 * reason each of them lost.
 *
 * Three things make that affordable in a browser.
 *
 * 1. Generation is almost linear in array size. An 8 kWp array on a given roof
 *    produces twice a 4 kWp array hour for hour, right up until the inverter
 *    clips, so the 8,760-hour irradiance model runs ONCE and every candidate
 *    scales it and applies its own clipping. That is the difference between a
 *    search and a wait.
 *
 * 2. Tariffs are shortlisted before designs are swept. Ranking 27 plans for
 *    every candidate is most of the cost and nearly all of it is wasted: the
 *    plans that suit a home are largely the same whether its array is 4 kWp or
 *    16. So the full field is ranked against a handful of reference designs
 *    first, and only the survivors are carried through the sweep. Pruning is
 *    what makes an optimiser an optimiser rather than a loop.
 *
 * 3. The sweep is coarse then fine. A wide, cheap pass finds the
 *    neighbourhood; a narrow, dense pass finds the answer inside it. Brute
 *    force over the same space costs an order of magnitude more and lands in
 *    the same place.
 *
 * The result carries `evaluated`: the number of full-year simulations actually
 * run. It is reported to the reader, so it has to be the truth rather than a
 * marketing number.
 */

import { HOURS_IN_YEAR, type Tariff } from './constants.js';
import { annualCost, simulateBaseline } from './tariff-rules.js';
import { simulateDispatch, batterySpec, type BatterySpec } from './dispatch.js';
import { npv20, breakevenYear } from './npv.js';

/* ------------------------------------------------------------------ inputs */

export interface HomeProfile {
  /** Generation for a 1 kWp array on this roof, 8,760 hours. */
  genPerKwp: Float32Array;
  /** Consumption including the EV, if there is one. */
  cons: Float32Array;
  /** Consumption excluding the EV — the baseline for a household without one. */
  consNoEv: Float32Array;
  /** Hourly wholesale adder for dynamic plans. */
  wholesale?: Float32Array | null;
  /** Does the bill being compared against already include the car? */
  evInBill: boolean;
  /** Export cap in kW, and whether the connection may export at all. */
  exportLimitKw: number;
  exportAllowed: boolean;
  /**
   * Inverter AC limit, kW. Generation scales linearly with array size right up
   * until it does not: above this the inverter clips, and the extra panels
   * produce nothing on exactly the bright days they were bought for. A search
   * that ignored clipping would recommend bigger and bigger arrays, because in
   * a linear model they always help.
   */
  inverterKw: number;
  /** Battery physical characteristics, minus the capacity being searched. */
  batteryMinSoc?: number;
  batteryMaxSoc?: number;
  batteryEff?: number;
}

export interface CostModel {
  /** Install cost before grant, for a given array and battery. */
  installCost: (kwp: number, batteryKwh: number) => number;
  /** Grant against that system. */
  grant: (kwp: number, batteryKwh: number) => number;
}

export interface SearchLimits {
  /** Watt-peak of one panel — the unit the reader actually buys. */
  panelWatts: number;
  /** How many panels physically fit. */
  maxPanels: number;
  minPanels?: number;
  /** Battery sizes on the market, kWh. 0 must be present: no battery is a design. */
  batteryOptions?: number[];
  /** How many tariffs survive the shortlist into the full sweep. */
  planShortlist?: number;
  /** Cap on total simulations, as a guard rather than a target. */
  maxEvaluations?: number;
}

export const DEFAULT_BATTERY_OPTIONS = [0, 5, 7.5, 10, 12.5, 15, 20];

/* ----------------------------------------------------------------- outputs */

/** One candidate system, fully priced. */
export interface Design {
  panels: number;
  kwp: number;
  batteryKwh: number;
  /** Arbitrage — charging the battery from the grid in cheap windows. */
  chargeFromGrid: boolean;
  /** The tariff this design is best on. */
  planId: string;
  planLabel: string;
  /** Install cost before grant, the grant, and what the reader actually pays. */
  cost: number;
  grant: number;
  netCost: number;
  /** Annual cost on this system and plan: import + standing − export. */
  annualNet: number;
  /** Annual saving against doing nothing. */
  annualBenefit: number;
  /** Years to repay netCost out of annualBenefit. 999 when it never does. */
  payback: number;
  /** Twenty-year net present value of the whole decision. */
  npv: number;
}

export interface SearchResult {
  /** The recommendation. Null when nothing in the space is worth buying. */
  best: Design | null;
  /** Every design that was fully priced, best first by NPV. */
  ranked: Design[];
  /** Doing nothing: the cheapest tariff with no system at all. */
  doNothing: { planId: string; planLabel: string; annualNet: number };
  /** Full-year simulations actually run. */
  evaluated: number;
  /** Tariffs carried from the shortlist into the sweep. */
  shortlist: string[];
  /** Milliseconds spent. */
  elapsedMs: number;
}

export interface Progress {
  /** 0–1. */
  fraction: number;
  evaluated: number;
  phase: 'tariffs' | 'coarse' | 'fine';
}

/* ------------------------------------------------------------------- guts */

/**
 * Generation for an array of `kwp`, from the unclipped per-kWp profile.
 *
 * The 8,760-hour irradiance and transposition model runs once for the roof;
 * every candidate is a scale factor on it, which is what makes a search
 * affordable at all. Clipping is applied here, per candidate, because it is
 * the one part that is not linear.
 */
const scaled = (perKwp: Float32Array, kwp: number, inverterKw: number): Float32Array => {
  const out = new Float32Array(HOURS_IN_YEAR);
  if (kwp === 0) return out;
  const cap = inverterKw > 0 ? inverterKw : Infinity;
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) out[i] = Math.min((perKwp[i] ?? 0) * kwp, cap);
  return out;
};

const label = (p: Tariff) => `${p.supplier} — ${p.plan}`;

/**
 * Cheapest annual cost for one physical system, over a set of tariffs.
 *
 * Both battery strategies are tried whenever there is a battery to run them
 * on, because which one wins depends on the tariff — that interaction is the
 * whole reason a 40c plan can beat a 34c one, and averaging it away would
 * throw out the finding the product exists to surface.
 */
function priceSystem(
  home: HomeProfile,
  plans: Tariff[],
  gen: Float32Array,
  battery: BatterySpec,
  count: { n: number },
): { planId: string; planLabel: string; annualNet: number; chargeFromGrid: boolean } | null {
  let best: { planId: string; planLabel: string; annualNet: number; chargeFromGrid: boolean } | null = null;
  const strategies = battery.capacityKwh > 0 ? [false, true] : [false];

  for (const plan of plans) {
    for (const chargeFromGrid of strategies) {
      const sim = simulateDispatch(plan, gen, home.cons, battery, {
        chargeFromGrid,
        exportEnabled: home.exportAllowed,
        exportLimitKw: home.exportLimitKw,
        wholesale: home.wholesale ?? null,
      });
      count.n += 1;
      const net = annualCost(sim, plan).net;
      if (!best || net < best.annualNet) {
        best = { planId: plan.id, planLabel: label(plan), annualNet: net, chargeFromGrid };
      }
    }
  }
  return best;
}

/** The cheapest tariff for this home with no system at all. */
function priceDoNothing(home: HomeProfile, plans: Tariff[], count: { n: number }) {
  const cons = home.evInBill ? home.cons : home.consNoEv;
  let best: { planId: string; planLabel: string; annualNet: number } | null = null;
  for (const plan of plans) {
    const sim = simulateBaseline(plan, cons);
    count.n += 1;
    const net = annualCost(sim, plan).net;
    if (!best || net < best.annualNet) best = { planId: plan.id, planLabel: label(plan), annualNet: net };
  }
  return best!;
}

function priceDesign(
  home: HomeProfile, plans: Tariff[], costs: CostModel, limits: SearchLimits,
  panels: number, batteryKwh: number, doNothingNet: number, count: { n: number },
): Design | null {
  const kwp = +((panels * limits.panelWatts) / 1000).toFixed(3);
  const battery = batterySpec(batteryKwh, home.batteryMinSoc ?? 0.1,
    home.batteryMaxSoc ?? 1.0, home.batteryEff ?? 0.9);
  const priced = priceSystem(home, plans, scaled(home.genPerKwp, kwp, home.inverterKw), battery, count);
  if (!priced) return null;

  const cost = costs.installCost(kwp, batteryKwh);
  const grant = costs.grant(kwp, batteryKwh);
  const netCost = Math.max(0, cost - grant);
  const annualBenefit = doNothingNet - priced.annualNet;
  const payback = annualBenefit > 0 ? netCost / annualBenefit : 999;

  return {
    panels,
    kwp,
    batteryKwh,
    chargeFromGrid: priced.chargeFromGrid,
    planId: priced.planId,
    planLabel: priced.planLabel,
    cost,
    grant,
    netCost,
    annualNet: Math.round(priced.annualNet),
    annualBenefit: Math.round(annualBenefit),
    payback: +payback.toFixed(1),
    npv: Math.round(npv20({ annualBenefit, sysCostNet: netCost, batteryKwh })),
  };
}

/** Distinct integers in [lo, hi], evenly spread, at most `n` of them. */
function spread(lo: number, hi: number, n: number): number[] {
  if (hi <= lo) return [lo];
  const out = new Set<number>();
  for (let i = 0; i < n; i += 1) out.add(Math.round(lo + ((hi - lo) * i) / (n - 1)));
  return [...out].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ search */

export function searchDesigns(
  home: HomeProfile,
  plans: Tariff[],
  costs: CostModel,
  limits: SearchLimits,
  onProgress?: (p: Progress) => void,
): SearchResult {
  const t0 = Date.now();
  const count = { n: 0 };
  const minPanels = limits.minPanels ?? 4;
  const maxPanels = Math.max(minPanels, limits.maxPanels);
  const batteries = limits.batteryOptions ?? DEFAULT_BATTERY_OPTIONS;
  const shortlistSize = limits.planShortlist ?? 6;
  const budget = limits.maxEvaluations ?? 6000;

  const doNothing = priceDoNothing(home, plans, count);
  onProgress?.({ fraction: 0.05, evaluated: count.n, phase: 'tariffs' });

  /* --- 1. shortlist tariffs against a few reference systems ---------------
   * A tariff that cannot win on a small array, a large one, or none at all is
   * not going to win somewhere in between. Ranking the full field four times
   * is far cheaper than ranking it at every point of the sweep.
   */
  const refPanels = spread(minPanels, maxPanels, 3);
  const refSystems: Array<[number, number]> = [
    [0, 0],
    [refPanels[0] ?? minPanels, 0],
    [refPanels[refPanels.length - 1] ?? maxPanels, 0],
    [refPanels[Math.floor(refPanels.length / 2)] ?? minPanels, batteries.find((b) => b > 0) ?? 0],
  ];

  const planScore = new Map<string, number>();
  for (const [panels, batt] of refSystems) {
    const kwp = (panels * limits.panelWatts) / 1000;
    const gen = scaled(home.genPerKwp, kwp, home.inverterKw);
    const battery = batterySpec(batt, home.batteryMinSoc ?? 0.1, home.batteryMaxSoc ?? 1.0, home.batteryEff ?? 0.9);
    for (const plan of plans) {
      const sim = simulateDispatch(plan, gen, home.cons, battery, {
        chargeFromGrid: batt > 0,
        exportEnabled: home.exportAllowed,
        exportLimitKw: home.exportLimitKw,
        wholesale: home.wholesale ?? null,
      });
      count.n += 1;
      const net = annualCost(sim, plan).net;
      // Best (lowest) cost this plan achieved on any reference system. A plan
      // that is only good with a big array must still make the shortlist.
      const prev = planScore.get(plan.id);
      if (prev == null || net < prev) planScore.set(plan.id, net);
    }
  }
  const shortlist = [...planScore.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, shortlistSize)
    .map(([id]) => id);
  const shortlisted = plans.filter((p) => shortlist.includes(p.id));
  onProgress?.({ fraction: 0.2, evaluated: count.n, phase: 'coarse' });

  /* --- 2. coarse sweep --------------------------------------------------- */
  const coarsePanels = spread(minPanels, maxPanels, 6);
  const coarseBatteries = batteries.filter((_, i) => i === 0 || i % 2 === 1);
  const priced: Design[] = [];
  const seen = new Set<string>();

  const evaluate = (panels: number, batt: number) => {
    const key = `${panels}:${batt}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (count.n >= budget) return;
    const d = priceDesign(home, shortlisted, costs, limits, panels, batt, doNothing.annualNet, count);
    if (d) priced.push(d);
  };

  const coarseTotal = coarsePanels.length * coarseBatteries.length;
  let done = 0;
  for (const panels of coarsePanels) {
    for (const batt of coarseBatteries) {
      evaluate(panels, batt);
      done += 1;
      onProgress?.({ fraction: 0.2 + 0.5 * (done / coarseTotal), evaluated: count.n, phase: 'coarse' });
    }
  }

  /* --- 3. refine around the leader ---------------------------------------
   * The coarse grid says which neighbourhood the answer is in; it is too
   * sparse to say where in it. Every panel count within a step of the leader
   * is tried, against every battery size on the market rather than every
   * second one — including no battery, which is frequently the right answer
   * and must never be reachable only by luck of the grid.
   */
  const leader = priced.slice().sort((a, b) => b.npv - a.npv)[0];
  if (leader) {
    const step = Math.max(1, Math.round((maxPanels - minPanels) / 5));
    const lo = Math.max(minPanels, leader.panels - step);
    const hi = Math.min(maxPanels, leader.panels + step);
    const fineTotal = (hi - lo + 1) * batteries.length;
    let fineDone = 0;
    for (let panels = lo; panels <= hi; panels += 1) {
      for (const batt of batteries) {
        evaluate(panels, batt);
        fineDone += 1;
        onProgress?.({ fraction: 0.7 + 0.29 * (fineDone / fineTotal), evaluated: count.n, phase: 'fine' });
      }
    }
  }

  /* --- 4. rank -----------------------------------------------------------
   * By 20-year NPV, not payback. Payback rewards the smallest system that
   * repays quickly; NPV asks what the decision is worth over its life, which
   * is the question someone spending €15,000 is actually asking. Ties within
   * 2% go to the cheaper system: paying less for the same outcome is strictly
   * better, and a marginal NPV difference is well inside the model's error.
   */
  const ranked = priced.slice().sort((a, b) => b.npv - a.npv);
  const top = ranked[0];
  let best: Design | null = null;
  if (top && top.npv > 0) {
    const near = ranked.filter((d) => d.npv >= top.npv * 0.98);
    best = near.reduce((a, b) => (b.netCost < a.netCost ? b : a));
  }

  onProgress?.({ fraction: 1, evaluated: count.n, phase: 'fine' });
  return {
    best,
    ranked,
    doNothing,
    evaluated: count.n,
    shortlist,
    elapsedMs: Date.now() - t0,
  };
}

/* ------------------------------------------------------------ explanations */

export type ReasonKind =
  | 'more-panels-beat-battery'
  | 'battery-earns-its-keep'
  | 'arbitrage'
  | 'self-consumption'
  | 'tariff-switch'
  | 'roof-limited'
  | 'not-worthwhile';

export interface Reason {
  kind: ReasonKind;
  /** Euro per year this specific finding is worth, where that is meaningful. */
  worth?: number;
  /** The design being compared against, when the finding is a comparison. */
  against?: Design;
}

/**
 * Why this one, in terms of the alternatives it beat.
 *
 * Not prose and not a language model: each of these is a comparison between
 * two designs the search actually priced. The interface turns them into
 * sentences. Keeping the reasoning as data means the claim on screen and the
 * number behind it cannot drift apart.
 */
export function explain(result: SearchResult, limits: SearchLimits): Reason[] {
  const { best, ranked } = result;
  if (!best) return [{ kind: 'not-worthwhile' }];
  const out: Reason[] = [];

  // The comparison everybody gets wrong, and the one installers are least able
  // to give honestly: panels versus a battery. It is stated against the best
  // design on the other side of that choice — not against a similarly-priced
  // one, because "the best battery system available to you" is what the reader
  // is actually weighing, whatever it happens to cost.
  if (best.batteryKwh === 0) {
    const bestWithBattery = ranked.find((d) => d.batteryKwh > 0);
    if (bestWithBattery) {
      out.push({
        kind: 'more-panels-beat-battery',
        worth: Math.round(best.npv - bestWithBattery.npv),
        against: bestWithBattery,
      });
    }
  } else {
    const bestWithout = ranked.find((d) => d.batteryKwh === 0);
    if (bestWithout) {
      out.push({
        kind: 'battery-earns-its-keep',
        worth: Math.round(best.npv - bestWithout.npv),
        against: bestWithout,
      });
    }
    out.push({ kind: best.chargeFromGrid ? 'arbitrage' : 'self-consumption' });
  }

  if (best.planId !== result.doNothing.planId) {
    out.push({ kind: 'tariff-switch' });
  }
  if (best.panels >= limits.maxPanels) {
    out.push({ kind: 'roof-limited' });
  }
  return out;
}

/**
 * How much to trust the recommendation, 0–1.
 *
 * A number on a screen next to a €15,000 decision has to mean something. This
 * one means: how far clear of the runner-up is the winner, and does it repay
 * within a horizon anyone can plan over. When two designs are within a few
 * euro a year of each other, confidence SHOULD be low — saying so is more
 * useful than a green badge that is always high.
 */
export function confidence(result: SearchResult): number {
  const { best, ranked } = result;
  if (!best || best.npv <= 0) return 0;
  const rival = ranked.find((d) => d.panels !== best.panels || d.batteryKwh !== best.batteryKwh);
  const margin = rival ? (best.npv - rival.npv) / Math.abs(best.npv) : 1;
  const clear = Math.min(1, Math.max(0, margin / 0.15));          // 15% clear = fully separated
  const repays = best.payback <= 10 ? 1 : best.payback <= 20 ? 0.6 : 0.2;
  return +(0.25 + 0.45 * clear + 0.30 * repays).toFixed(2);
}

export { breakevenYear };

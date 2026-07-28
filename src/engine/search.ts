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
import { annualCost, simulateBaseline, sumF } from './tariff-rules.js';
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
  /** What "best" means for this reader. Defaults to maximising return. */
  goal?: Goal;
  /**
   * Which goals to refine for. Defaults to all of them: one sweep answers
   * every goal, and refining for all four costs far less than searching four
   * times. Narrow it only when a caller genuinely wants one answer.
   */
  goals?: Goal[];
  /** Borrowing terms for the bill-swap goal. Defaults to a green home loan. */
  finance?: FinanceModel | null;
}

export const DEFAULT_BATTERY_OPTIONS = [0, 5, 7.5, 10, 12.5, 15, 20];

/* ------------------------------------------------------------------- goals */

/**
 * What "best" means, which is not a technical question.
 *
 * The same house, the same roof and the same tariffs produce different right
 * answers depending on what the person is trying to do, and the engine has no
 * business deciding that for them. Every goal below is a real position someone
 * holds, and each one selects a genuinely different system:
 *
 * - `max-return`   Treat the roof as an investment. Maximise what the decision
 *                  is worth over twenty years. Tends to fill the roof.
 * - `bill-swap`    Don't spend savings — borrow, and stop paying the utility
 *                  in order to start paying the bank instead. The binding
 *                  constraint is that the repayment must not exceed what the
 *                  system saves, so the household is better off from month
 *                  one. Tends toward smaller, cheaper systems.
 * - `independence` Minimise reliance on the grid, accepting a worse return for
 *                  it. Tends to buy a battery, and a large one.
 * - `fast-payback` Get the money back quickly and take low risk on the rest.
 *                  Tends to the smallest system that clearly repays.
 *
 * They are not presets over one ranking; they are different objective
 * functions, some with hard feasibility constraints. A `bill-swap` answer that
 * costs more per month than it saves is not a worse answer, it is not an
 * answer.
 */
export type Goal = 'max-return' | 'bill-swap' | 'independence' | 'fast-payback';

export const GOALS: Goal[] = ['max-return', 'bill-swap', 'independence', 'fast-payback'];

/** Borrowing terms, when the reader intends to finance rather than pay cash. */
export interface FinanceModel {
  /** Nominal annual interest rate, e.g. 0.065 for 6.5%. */
  annualRate: number;
  /** Term in years. */
  termYears: number;
}

/** Green home-improvement loans in Ireland sit around here in 2026. */
export const DEFAULT_FINANCE: FinanceModel = { annualRate: 0.062, termYears: 10 };

/** Level monthly repayment on an amortising loan. */
export function monthlyRepayment(principal: number, finance: FinanceModel | null): number {
  if (!finance || principal <= 0 || finance.termYears <= 0) return 0;
  const n = finance.termYears * 12;
  const r = finance.annualRate / 12;
  if (r <= 0) return principal / n;
  return (principal * r) / (1 - (1 + r) ** -n);
}

/**
 * Each goal as a score to maximise, plus what disqualifies a design outright.
 *
 * Scores are only ever compared within one goal, so their units do not need to
 * agree with each other — but a design that fails `feasible` is never
 * recommended for that goal at all, however well it scores.
 */
interface GoalSpec {
  score: (d: Design) => number;
  feasible: (d: Design) => boolean;
  /** Among designs scoring within this fraction of the leader, prefer cheaper. */
  tieBand: number;
}

const GOAL_SPECS: Record<Goal, GoalSpec> = {
  'max-return': {
    score: (d) => d.npv,
    feasible: (d) => d.npv > 0,
    tieBand: 0.02,
  },
  'bill-swap': {
    // Maximise how much better off the household is each month once the loan
    // is being paid. A system that cannot cover its own repayment fails.
    score: (d) => d.monthlyNetChange,
    feasible: (d) => d.monthlyNetChange > 0 && d.annualBenefit > 0,
    tieBand: 0.05,
  },
  independence: {
    // Self-sufficiency first, but not at any price: a system that never repays
    // is not independence, it is an expensive hobby. Among designs that do
    // repay inside their working life, take the most autonomous.
    score: (d) => d.selfSufficiency,
    feasible: (d) => d.payback < 20 && d.annualBenefit > 0,
    tieBand: 0.01,
  },
  'fast-payback': {
    score: (d) => -d.payback,
    feasible: (d) => d.payback < 15 && d.annualBenefit > 0,
    // Tight, unlike the others. Within 1% two paybacks are a fortnight apart
    // and genuinely indistinguishable; any wider and the answer labelled
    // "fastest payback" stops being the fastest, which is simply untrue.
    tieBand: 0.01,
  },
};

/** Pick the winner for one goal out of a set of priced designs. */
export function pickForGoal(designs: Design[], goal: Goal): Design | null {
  const spec = GOAL_SPECS[goal];
  const eligible = designs.filter(spec.feasible);
  if (!eligible.length) return null;
  const ranked = eligible.slice().sort((a, b) => spec.score(b) - spec.score(a));
  const top = ranked[0]!;
  const topScore = spec.score(top);
  // Within the tie band the outcomes are indistinguishable given the model's
  // own error, so paying less for the same result wins.
  const near = ranked.filter((d) => {
    const s = spec.score(d);
    return Math.abs(topScore) > 0
      ? s >= topScore - Math.abs(topScore) * spec.tieBand
      : s >= topScore;
  });
  return near.reduce((a, b) => (b.netCost < a.netCost ? b : a));
}

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
  /** kWh bought from and sold to the grid over a year. */
  importKwh: number;
  exportKwh: number;
  /**
   * Share of the home's demand met from its own generation, 0–1. Grid-charged
   * battery energy does not count: that is cheaper dependence, not autonomy.
   */
  selfSufficiency: number;
  /** Monthly loan repayment if the system is financed. Zero without a loan. */
  monthlyRepayment: number;
  /**
   * Monthly change in total outgoings once the system is financed: the fall in
   * the electricity bill minus the loan repayment. Positive means the reader
   * is better off from month one — the bill has been swapped for the
   * repayment, at a profit.
   */
  monthlyNetChange: number;
}

export interface SearchResult {
  /** The recommendation for the goal that was asked for. Null when nothing in
   * the space satisfies it. */
  best: Design | null;
  /** The goal `best` answers. */
  goal: Goal;
  /**
   * The answer for every goal, from the same sweep. Showing the reader what
   * their choice of goal costs them under the others is most of the value:
   * "the independence system saves €260 a year less than the investment one"
   * is a decision, where either number alone is just a recommendation.
   */
  byGoal: Record<Goal, Design | null>;
  /** The borrowing terms `monthlyRepayment` was computed on, if any. */
  finance: FinanceModel | null;
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
interface PricedSystem {
  planId: string;
  planLabel: string;
  annualNet: number;
  chargeFromGrid: boolean;
  /** kWh bought from the grid over the year. */
  importKwh: number;
  /** kWh sold. */
  exportKwh: number;
  /** Share of the home's demand met without the grid, 0–1. */
  selfSufficiency: number;
}

/**
 * The cheapest tariff for this system, once per battery strategy.
 *
 * Not one winner: two. Self-consumption and grid arbitrage are different
 * products, not two settings of one, and collapsing them by cost alone was a
 * real defect — the cost-optimal strategy for a battery is usually arbitrage,
 * which is cheaper dependence rather than autonomy, so the independence goal
 * was handed a battery design with the self-sufficiency of a house that has no
 * battery at all. It concluded, reasonably and wrongly, that storage does not
 * help you leave the grid.
 *
 * Both survive to the ranking, and the goal decides. No extra simulations: the
 * same runs, not thrown away.
 */
function priceSystem(
  home: HomeProfile,
  plans: Tariff[],
  gen: Float32Array,
  battery: BatterySpec,
  count: { n: number },
): PricedSystem[] {
  const strategies = battery.capacityKwh > 0 ? [false, true] : [false];
  const best = new Map<boolean, PricedSystem>();
  const demand = sumF(home.cons);

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
      const incumbent = best.get(chargeFromGrid);
      if (!incumbent || net < incumbent.annualNet) {
        // Import includes grid charging for arbitrage, which is right for cost
        // and wrong for independence: a battery filled from the grid is not
        // autonomy. Self-sufficiency counts only demand met from the home's
        // own generation, directly or through the battery.
        const ownSupply = sumF(sim.self_use) + sumF(sim.battery_discharge)
          * (chargeFromGrid ? 0 : Math.sqrt(battery.roundTripEff));
        best.set(chargeFromGrid, {
          planId: plan.id,
          planLabel: label(plan),
          annualNet: net,
          chargeFromGrid,
          importKwh: sumF(sim.grid_import),
          exportKwh: sumF(sim.grid_export),
          selfSufficiency: demand > 0 ? Math.min(1, ownSupply / demand) : 0,
        });
      }
    }
  }
  return [...best.values()];
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
  finance: FinanceModel | null,
): Design[] {
  const kwp = +((panels * limits.panelWatts) / 1000).toFixed(3);
  const battery = batterySpec(batteryKwh, home.batteryMinSoc ?? 0.1,
    home.batteryMaxSoc ?? 1.0, home.batteryEff ?? 0.9);
  const variants = priceSystem(home, plans, scaled(home.genPerKwp, kwp, home.inverterKw), battery, count);

  const cost = costs.installCost(kwp, batteryKwh);
  const grant = costs.grant(kwp, batteryKwh);
  const netCost = Math.max(0, cost - grant);
  const repayment = monthlyRepayment(netCost, finance);

  return variants.map((priced) => {
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
    importKwh: Math.round(priced.importKwh),
    exportKwh: Math.round(priced.exportKwh),
    selfSufficiency: +priced.selfSufficiency.toFixed(3),
    monthlyRepayment: +repayment.toFixed(2),
    monthlyNetChange: +(annualBenefit / 12 - repayment).toFixed(2),
  };
  });
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
  const goal: Goal = limits.goal ?? 'max-return';
  const goals = limits.goals ?? GOALS;
  const finance = limits.finance ?? DEFAULT_FINANCE;
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
    for (const d of priceDesign(home, shortlisted, costs, limits, panels, batt,
      doNothing.annualNet, count, finance)) priced.push(d);
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

  /* --- 3. refine around every goal's leader -------------------------------
   * The coarse grid says which neighbourhood an answer is in; it is too sparse
   * to say where in it. Every panel count within a step of a leader is tried,
   * against every battery size on the market rather than every second one —
   * including no battery, which is frequently the right answer and must never
   * be reachable only by luck of the grid.
   *
   * Every goal gets its own refinement, because they lead to different
   * neighbourhoods: max-return fills the roof, bill-swap wants the cheapest
   * system that covers its own repayment, independence wants the biggest
   * battery that still repays. Refining only around the investment answer
   * would leave the other three answered by the coarse grid alone — the same
   * silent second-best the pruning tests exist to prevent.
   */
  const neighbourhoods = new Set<number>();
  for (const goal of goals) {
    const leader = pickForGoal(priced, goal) ?? priced.slice().sort((a, b) => b.npv - a.npv)[0];
    if (leader) neighbourhoods.add(leader.panels);
  }
  const step = Math.max(1, Math.round((maxPanels - minPanels) / 5));
  const fineTotal = neighbourhoods.size * (2 * step + 1) * batteries.length;
  let fineDone = 0;
  for (const centre of neighbourhoods) {
    const lo = Math.max(minPanels, centre - step);
    const hi = Math.min(maxPanels, centre + step);
    for (let panels = lo; panels <= hi; panels += 1) {
      for (const batt of batteries) {
        evaluate(panels, batt);
        fineDone += 1;
        onProgress?.({ fraction: 0.7 + 0.29 * Math.min(1, fineDone / Math.max(1, fineTotal)),
          evaluated: count.n, phase: 'fine' });
      }
    }
  }

  /* --- 4. rank, once per goal --------------------------------------------
   * One sweep, four answers. The designs are the same; what differs is what
   * "best" means, and that is the reader's to choose rather than the engine's
   * to assume. `best` is the answer for the goal that was asked for.
   */
  const ranked = priced.slice().sort((a, b) => b.npv - a.npv);
  const byGoal = {} as Record<Goal, Design | null>;
  for (const g of GOALS) byGoal[g] = pickForGoal(priced, g);
  const best = byGoal[goal] ?? null;

  onProgress?.({ fraction: 1, evaluated: count.n, phase: 'fine' });
  return {
    best,
    goal,
    byGoal,
    ranked,
    doNothing,
    finance,
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
  | 'covers-its-own-repayment'
  | 'independence-costs-return'
  | 'goal-changes-the-answer'
  | 'not-worthwhile'
  | 'no-system-meets-this-goal';

export interface Reason {
  kind: ReasonKind;
  /** What this finding is worth. Units depend on the kind; see each use. */
  worth?: number;
  /** The design being compared against, when the finding is a comparison. */
  against?: Design;
  /** The goal being compared against, for `goal-changes-the-answer`. */
  goal?: Goal;
}

/**
 * Why this one, in terms of the alternatives it beat.
 *
 * Not prose and not a language model: each of these is a comparison between
 * two designs the search actually priced. The interface turns them into
 * sentences. Keeping the reasoning as data means the claim on screen and the
 * number behind it cannot drift apart.
 *
 * The reasons depend on the goal, because the argument for a system is not the
 * same argument under a different objective. A large array is recommended to
 * an investor because it earns most; the same array recommended to someone
 * swapping their bill for a repayment would need a different justification,
 * and giving the investment one would be a non-sequitur dressed as advice.
 */
export function explain(result: SearchResult, limits: SearchLimits): Reason[] {
  const { best, ranked, byGoal, goal } = result;
  if (!best) {
    // Distinguish "nothing here is worth buying" from "nothing here meets the
    // constraint you set". They call for completely different next steps: the
    // first ends the conversation, the second is a nudge to relax the goal.
    const anythingWorthwhile = Object.values(byGoal).some(Boolean)
      || ranked.some((d) => d.npv > 0);
    return [{ kind: anythingWorthwhile ? 'no-system-meets-this-goal' : 'not-worthwhile' }];
  }
  const out: Reason[] = [];

  // The comparison everybody gets wrong, and the one installers are least able
  // to give honestly: panels versus a battery. It is stated against the best
  // design on the other side of that choice — not against a similarly-priced
  // one, because "the best battery system available to you" is what the reader
  // is actually weighing, whatever it happens to cost.
  //
  // Scored on the goal in play: under `independence` a battery can be right
  // even though it loses money, and quoting its NPV shortfall as the reason it
  // won would be incoherent.
  const value = (d: Design) => (goal === 'independence' ? d.selfSufficiency * 100
    : goal === 'bill-swap' ? d.monthlyNetChange * 12
      : goal === 'fast-payback' ? -d.payback
        : d.npv);

  if (best.batteryKwh === 0) {
    const rival = ranked.find((d) => d.batteryKwh > 0);
    if (rival) {
      out.push({ kind: 'more-panels-beat-battery', worth: Math.round(value(best) - value(rival)), against: rival });
    }
  } else {
    const rival = ranked.find((d) => d.batteryKwh === 0);
    if (rival) {
      out.push({ kind: 'battery-earns-its-keep', worth: Math.round(value(best) - value(rival)), against: rival });
    }
    out.push({ kind: best.chargeFromGrid ? 'arbitrage' : 'self-consumption' });
  }

  if (goal === 'bill-swap') {
    // The whole proposition, as a number: what the household is up each month
    // once the loan is being paid.
    out.push({ kind: 'covers-its-own-repayment', worth: Math.round(best.monthlyNetChange) });
  }

  if (goal === 'independence') {
    const investor = byGoal['max-return'];
    if (investor && investor.npv > best.npv) {
      // Independence has a price, and the reader is entitled to see it before
      // choosing rather than after.
      out.push({ kind: 'independence-costs-return', worth: Math.round(investor.npv - best.npv), against: investor });
    }
  }

  // Where a different goal would have bought a different system, say so. This
  // is the honest version of a recommendation: the answer changed because of
  // what you told us you wanted, not because the arithmetic says so.
  for (const g of GOALS) {
    const other = byGoal[g];
    if (!other || g === goal) continue;
    if (other.panels !== best.panels || other.batteryKwh !== best.batteryKwh) {
      out.push({ kind: 'goal-changes-the-answer', goal: g, against: other });
      break;
    }
  }

  if (best.planId !== result.doNothing.planId) out.push({ kind: 'tariff-switch' });
  if (best.panels >= limits.maxPanels) out.push({ kind: 'roof-limited' });
  return out;
}

/**
 * How much to trust the recommendation, 0–1.
 *
 * A number on a screen next to a €15,000 decision has to mean something. This
 * one means: how far clear of the runner-up is the winner, on the goal that
 * was actually asked for, and does it repay within a horizon anyone can plan
 * over. When two designs are within a few euro of each other, confidence
 * SHOULD be low — saying so is more useful than a green badge that is always
 * high.
 */
export function confidence(result: SearchResult): number {
  const { best, ranked, goal } = result;
  if (!best) return 0;
  const spec = GOAL_SPECS[goal];
  if (!spec.feasible(best)) return 0;

  const rival = ranked
    .filter((d) => (d.panels !== best.panels || d.batteryKwh !== best.batteryKwh) && spec.feasible(d))
    .sort((a, b) => spec.score(b) - spec.score(a))[0];

  const top = spec.score(best);
  const margin = rival && Math.abs(top) > 1e-9
    ? (top - spec.score(rival)) / Math.abs(top)
    : 1;
  const clear = Math.min(1, Math.max(0, margin / 0.15));          // 15% clear = fully separated
  const repays = best.payback <= 10 ? 1 : best.payback <= 20 ? 0.6 : 0.2;
  return +(0.25 + 0.45 * clear + 0.30 * repays).toFixed(2);
}

export { breakevenYear };

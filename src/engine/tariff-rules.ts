/**
 * Tariff band resolution and cost aggregation. Pure: no state, no cache.
 *
 * `rateAt` takes the wholesale series explicitly rather than reaching into a
 * module cache, so a dynamic plan can be priced against any curve — including a
 * fixed one in tests.
 */

import { HOURS_IN_YEAR, type Band, type HourWindow, type Tariff } from './constants.js';

/**
 * CRU cap on the customer billing rate for a dynamic plan, euro/kWh.
 * Bounds the wholesale component so a market spike cannot produce an
 * unbounded bill.
 */
export const WHOLESALE_CAP = 0.50;

/**
 * Is `hour` inside `window`? Start is inclusive, end exclusive. A window whose
 * start is greater than its end wraps past midnight — e.g. [23, 8] is 11pm-8am.
 */
export function isInWindow(hour: number, window: HourWindow | undefined): boolean {
  if (!window) return false;
  const [a, b] = window;
  if (a < b) return hour >= a && hour < b;
  return hour >= a || hour < b;
}

/**
 * Which band applies at `hour`. Order matters: the most specific window wins,
 * and `day` is the fallback when nothing matches.
 */
export function bandAt(hour: number, plan: Tariff): Band {
  const w = plan.windows ?? {};
  if (isInWindow(hour, w.wfh)) return 'wfh';
  if (isInWindow(hour, w.ev)) return 'ev';
  if (isInWindow(hour, w.peak)) return 'peak';
  if (isInWindow(hour, w.night)) return 'night';
  return 'day';
}

/**
 * Unit rate at a given hour, euro/kWh.
 *
 * Dynamic plans add a wholesale component to their standing unit rate, capped
 * so a price spike cannot produce an unbounded bill.
 */
export function rateAt(
  hour: number,
  plan: Tariff,
  hourIdx?: number,
  wholesale?: Float32Array | null,
): number {
  const base = plan.rates[bandAt(hour, plan)] ?? plan.rates.day ?? 0;
  if (plan.type === 'dynamic' && hourIdx != null && wholesale) {
    const w = wholesale[hourIdx] ?? 0;
    return Math.min(WHOLESALE_CAP + base, base + w);
  }
  return base;
}

/**
 * A plan whose bands are all within 0.1c of each other is flat in practice,
 * regardless of how many bands it declares.
 */
export function isFlatPlan(plan: Tariff): boolean {
  const r = plan.rates ?? {};
  const vals = [r.day, r.night, r.peak, r.ev].filter((v): v is number => v != null);
  if (vals.length < 2) return true;
  return Math.max(...vals) - Math.min(...vals) < 0.001;
}

export interface BaselineResult {
  grid_import: Float32Array;
  cost: Float32Array;
  band: Band[];
}

/** Cost of meeting consumption entirely from the grid — no solar, no battery. */
export function simulateBaseline(
  plan: Tariff,
  cons: Float32Array,
  wholesale?: Float32Array | null,
): BaselineResult {
  const out: BaselineResult = {
    grid_import: new Float32Array(HOURS_IN_YEAR),
    cost: new Float32Array(HOURS_IN_YEAR),
    band: new Array<Band>(HOURS_IN_YEAR),
  };
  const isDynamic = plan.type === 'dynamic';
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    const hour = i % 24;
    const band = bandAt(hour, plan);
    const use = cons[i] ?? 0;
    out.band[i] = band;
    out.grid_import[i] = use;
    const rate = isDynamic ? rateAt(hour, plan, i, wholesale) : (plan.rates[band] ?? 0);
    out.cost[i] = use * rate;
  }
  return out;
}

export function sumF(arr: Float32Array | undefined | null): number {
  if (!arr) return 0;
  let total = 0;
  for (let i = 0; i < arr.length; i += 1) total += arr[i] ?? 0;
  return total;
}

export interface AnnualCost {
  energy_cost: number;
  standing: number;
  export_revenue: number;
  /** Import cost + standing charge − export revenue, INCLUDING any announced
   *  price change over the year ahead. The comparable figure. */
  net: number;
  /** The extra euro a year an announced-but-not-yet-effective price change adds
   *  over the coming 12 months. 0 when there is no pending change. Kept separate
   *  so the reader can see today's cost and the outlook apart. */
  outlook_extra: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * How much of the year ahead a pending price change actually applies to.
 *
 * A rise announced for 1 October only affects the slice of a 12-month contract
 * that falls on or after that date, so its weight is the fraction of the next
 * 365 days lying past the effective date. A change already in effect (date in
 * the past) weighs nothing here — by then the rates themselves must have been
 * updated, which the freshness test enforces — and one more than a year out
 * does not touch this contract.
 */
export function pendingWeight(plan: Tariff, asOf: Date): number {
  const pc = plan.price_change;
  if (!pc?.effective_date) return 0;
  const eff = Date.parse(`${pc.effective_date}T00:00:00Z`);
  if (Number.isNaN(eff)) return 0;
  const days = (eff - asOf.getTime()) / MS_PER_DAY;
  if (days <= 0 || days >= 365) return 0;
  return (365 - days) / 365;
}

/**
 * Annualised cost on a plan.
 *
 * Netting convention: every figure the app compares is import cost plus
 * standing charge minus export revenue. Both the baseline and the candidate
 * plan are computed on this same basis, so they are directly comparable.
 */
export function annualCost(
  sim: { cost: Float32Array; revenue?: Float32Array | null },
  plan: Tariff,
  asOf: Date = new Date(),
): AnnualCost {
  const energy = sumF(sim.cost);
  const revenue = sumF(sim.revenue);
  // An announced rise costs the reader over the part of the year it applies to.
  // Energy scales linearly with the unit rate, so a +pct rise for the weighted
  // fraction w of the year adds energy*w*pct; a separately-announced standing
  // move adds standing*w*standing_pct.
  const w = pendingWeight(plan, asOf);
  const pc = plan.price_change;
  const outlook_extra = w > 0 && pc
    ? energy * w * pc.pct + plan.standing * w * (pc.standing_pct ?? 0)
    : 0;
  return {
    energy_cost: energy,
    standing: plan.standing,
    export_revenue: revenue,
    net: energy + plan.standing - revenue + outlook_extra,
    outlook_extra,
  };
}

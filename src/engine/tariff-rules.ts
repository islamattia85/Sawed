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
  /** Import cost + standing charge − export revenue. The comparable figure. */
  net: number;
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
): AnnualCost {
  const energy = sumF(sim.cost);
  const revenue = sumF(sim.revenue);
  return {
    energy_cost: energy,
    standing: plan.standing,
    export_revenue: revenue,
    net: energy + plan.standing - revenue,
  };
}

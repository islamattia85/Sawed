/**
 * The dispatch loop moved out of the UI module and into engine/dispatch.ts so
 * a design search can run it against hundreds of hypothetical systems, off the
 * main thread, without a global `state` to read from.
 *
 * An extraction that changes the numbers is not an extraction, it is a silent
 * regression in a product whose whole claim is that the numbers are right. So
 * the implementation as it stood immediately before the move is reproduced
 * verbatim below — reading a plain object where it used to read `state` — and
 * every one of the 8,760 hours must match exactly, for every plan shape the
 * app supports.
 *
 * When this file is eventually deleted, it should be because the search has
 * been trusted in production for a while, not because it became inconvenient.
 */
import { describe, it, expect } from 'vitest';
import { HOURS_IN_YEAR, type Tariff } from '../../src/engine/constants.js';
import { bandAt, rateAt } from '../../src/engine/tariff-rules.js';
import { simulateDispatch, batterySpec } from '../../src/engine/dispatch.js';

/* ---- the pre-extraction implementation, verbatim but for its inputs ---- */
/* eslint-disable */
// @ts-nocheck
function legacySimulate(plan: any, gen: Float32Array, cons: Float32Array,
                        strategy: any, state: any, wholesale: Float32Array | null): any {
  const rateAtL = (hour: number, plan: any, hourIdx?: number) => rateAt(hour, plan, hourIdx, wholesale);
  const cap = state.battery_kwh || 0;          // usable kWh
  const minSoc = state.battery_min * cap;
  const maxSoc = (state.battery_max || 1.0) * cap;
  const eff = Math.sqrt(state.battery_eff); // applied each way
  const maxChargeKw = 5.0;                       // typical hybrid inverter limit
  const maxDischargeKw = 5.0;
  const isDynamic = plan.type === "dynamic";

  // For dynamic tariffs: pre-compute effective rates for the year
  let effRates = null;
  if (isDynamic){
    effRates = new Float32Array(HOURS_IN_YEAR);
    for (let i=0; i<HOURS_IN_YEAR; i++){
      const hour = i % 24;
      effRates[i] = rateAtL(hour, plan, i);
    }
  }

  // Hourly outputs
  const out = {
    gen: gen,
    cons: cons,
    soc: new Float32Array(HOURS_IN_YEAR+1),
    grid_import: new Float32Array(HOURS_IN_YEAR),
    grid_export: new Float32Array(HOURS_IN_YEAR),
    battery_charge: new Float32Array(HOURS_IN_YEAR),  // kWh into battery
    battery_discharge: new Float32Array(HOURS_IN_YEAR), // kWh out of battery
    self_use: new Float32Array(HOURS_IN_YEAR),       // solar used directly
    curtailed: new Float32Array(HOURS_IN_YEAR),      // solar wasted due to export disabled / limit reached
    cost: new Float32Array(HOURS_IN_YEAR),
    revenue: new Float32Array(HOURS_IN_YEAR),
    band: new Array(HOURS_IN_YEAR),
    eff_rate: effRates,                              // hourly effective rates (dynamic only)
    plan_id: plan.id
  };

  let soc = minSoc + 0.3*(cap - minSoc); // start at 30% above min
  const exportRate = plan.export_rate;
  const peakRate = plan.rates.peak;
  const evRate = plan.windows.ev ? plan.rates.ev : null;

  // Export hardware constraints — if disabled, surplus is curtailed (clipped, not earned)
  const exportEnabled = state.export_enabled !== false;
  const exportLimit = exportEnabled ? (state.export_limit_kw || 999) : 0;

  for (let i=0; i<HOURS_IN_YEAR; i++){
    out.soc[i] = soc;
    const hour = i % 24;
    const g = gen[i] as number;
    const c = cons[i] as number;
    const band = bandAt(hour, plan);
    out.band[i] = band;
    const rate = isDynamic ? effRates![i] : (plan.rates[band] ?? plan.rates.day ?? 0);

    // For dynamic, determine if THIS hour is cheap vs the surrounding 24h
    let isCheapDynamic = false, isExpensiveDynamic = false, dailyAvg = 0;
    if (isDynamic){
      let sum = 0, n = 0;
      for (let k=0; k<24 && i+k<HOURS_IN_YEAR; k++){ sum += effRates![i+k] ?? 0; n++; }
      dailyAvg = n > 0 ? sum/n : rate;
      isCheapDynamic = rate < dailyAvg * 0.65;
      isExpensiveDynamic = rate > dailyAvg * 1.40;
    }

    let netSolarAfterLoad = g - c;   // positive = surplus, negative = deficit
    let directSelfUse = Math.min(g, c);
    out.self_use[i] = directSelfUse;

    let charge = 0, discharge = 0, imp = 0, exp = 0;

    // === Strategy logic ===
    let curtailed = 0;
    if (netSolarAfterLoad > 0){
      // Solar surplus. Decide: store in battery vs export.
      const headroom = maxSoc - soc;
      const canStore = Math.min(headroom / eff, maxChargeKw, netSolarAfterLoad);
      // If export rate > expected discharge value AND export is enabled, prefer export
      const expectedDischargeValue = isDynamic ? dailyAvg * 1.5 : peakRate;
      if (exportEnabled && exportRate * 1.0 > expectedDischargeValue * eff * eff){
        exp = netSolarAfterLoad;
      } else {
        charge = canStore;
        soc += charge * eff;
        const leftover = netSolarAfterLoad - charge;
        exp = Math.max(0, leftover);
      }
      // Apply hardware constraint: cap export at limit (excess is curtailed, lost)
      if (exp > exportLimit){
        curtailed = exp - exportLimit;
        exp = exportLimit;
      }
      out.curtailed[i] = curtailed;
    } else if (netSolarAfterLoad < 0){
      // Deficit — need to import or discharge battery
      const deficit = -netSolarAfterLoad;

      // Cheap-window determination (when we charge from grid)
      const isCheapWindow = isDynamic
        ? isCheapDynamic
        : ((band === "ev") || (band === "night" && rate <= 0.20));

      // Expensive-window determination (when we want to discharge)
      const isExpensiveWindow = isDynamic
        ? isExpensiveDynamic
        : (band === "peak" || band === "day");

      if (isExpensiveWindow && !isCheapWindow){
        // Discharge to meet load
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw);
        const energyOut = dis * eff;
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - energyOut);
      } else if (isCheapWindow){
        // Cheap — charge battery from grid + meet load from grid
        if (strategy.charge_from_grid){
          const headroom = maxSoc - soc;
          // For dynamic: only charge if room AND we have hours that are noticeably cheap
          const chargeAmt = Math.min(headroom / eff, maxChargeKw);
          charge = chargeAmt;
          soc += chargeAmt * eff;
          imp = deficit + charge;
        } else {
          imp = deficit;
        }
      } else {
        // Neutral hour — meet load with battery if available, else import
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw * 0.5);
        const energyOut = dis * eff;
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - energyOut);
      }
    }

    out.grid_import[i] = imp;
    out.grid_export[i] = exp;
    out.battery_charge[i] = charge;
    out.battery_discharge[i] = discharge;
    out.cost[i] = imp * rate;
    out.revenue[i] = exp * exportRate;
  }
  out.soc[HOURS_IN_YEAR] = soc;
  return out;
}
/* eslint-enable */

/* ---------------------------------------------------------------- fixtures */

/** A year of generation with a plausible seasonal and daily shape. */
function genProfile(kwp: number): Float32Array {
  const a = new Float32Array(HOURS_IN_YEAR);
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    const doy = Math.floor(i / 24);
    const h = i % 24;
    const season = 0.5 + 0.5 * Math.sin(((doy - 80) / 365) * 2 * Math.PI);
    const day = Math.max(0, Math.sin(((h - 6) / 13) * Math.PI));
    a[i] = kwp * season * day * 0.75;
  }
  return a;
}

/** A year of consumption: a morning peak, an evening peak, a night floor. */
function consProfile(annualKwh: number): Float32Array {
  const a = new Float32Array(HOURS_IN_YEAR);
  let total = 0;
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    const h = i % 24;
    const v = 0.25 + (h >= 7 && h <= 9 ? 0.9 : 0) + (h >= 17 && h <= 21 ? 1.3 : 0);
    a[i] = v;
    total += v;
  }
  const k = annualKwh / total;
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) a[i] = (a[i] ?? 0) * k;
  return a;
}

function wholesaleProfile(): Float32Array {
  const a = new Float32Array(HOURS_IN_YEAR);
  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    a[i] = 0.05 + 0.04 * Math.sin((i / 24) * 2 * Math.PI) + 0.02 * Math.sin(i / 100);
  }
  return a;
}

// Every plan in tariffs.json declares a peak rate, so this is the shape the
// parity claim is actually about. The peak-less case is covered on its own
// below, as a deliberate divergence rather than a regression.
const FLAT: Tariff = {
  id: 'flat', supplier: 'S', plan: 'Flat', type: 'standard',
  rates: { day: 0.35, peak: 0.35 }, windows: {}, standing: 300, export_rate: 0.20,
} as unknown as Tariff;

/** A plan that declares no peak band at all. */
const NO_PEAK: Tariff = {
  id: 'nopeak', supplier: 'S', plan: 'No peak band', type: 'standard',
  rates: { day: 0.35 }, windows: {}, standing: 300, export_rate: 0.20,
} as unknown as Tariff;

const DAY_NIGHT: Tariff = {
  id: 'dn', supplier: 'S', plan: 'Day/Night', type: 'standard',
  rates: { day: 0.38, night: 0.16, peak: 0.44 },
  windows: { night: [23, 8], peak: [17, 19] }, standing: 320, export_rate: 0.20,
} as unknown as Tariff;

const SMART_EV: Tariff = {
  id: 'ev', supplier: 'S', plan: 'Smart EV', type: 'standard',
  rates: { day: 0.40, night: 0.18, peak: 0.46, ev: 0.08 },
  windows: { night: [23, 8], peak: [17, 19], ev: [2, 5] }, standing: 340, export_rate: 0.21,
} as unknown as Tariff;

const DYNAMIC: Tariff = {
  id: 'dyn', supplier: 'S', plan: 'Dynamic', type: 'dynamic',
  rates: { day: 0.12 }, windows: {}, standing: 350, export_rate: 0.19,
} as unknown as Tariff;

/** The eleven values the loop used to read straight off the global state. */
const HOUSE = {
  battery_min: 0.1, battery_max: 1.0, battery_eff: 0.9,
  battery_kwh: 0, export_enabled: true, export_limit_kw: 6,
};

const PLANS: Array<[string, Tariff]> = [
  ['a flat tariff', FLAT],
  ['a day/night tariff', DAY_NIGHT],
  ['a smart EV tariff with a cheap window', SMART_EV],
  ['a dynamic wholesale tariff', DYNAMIC],
];

/** Every arrangement of the levers that changes which branch the loop takes. */
const CASES = [
  { name: 'no solar, no battery', kwp: 0, batt: 0, grid: false, exp: true, limit: 6 },
  { name: 'solar only', kwp: 5, batt: 0, grid: false, exp: true, limit: 6 },
  { name: 'solar and battery, self-consumption', kwp: 5, batt: 10, grid: false, exp: true, limit: 6 },
  { name: 'solar and battery, grid arbitrage', kwp: 5, batt: 10, grid: true, exp: true, limit: 6 },
  { name: 'battery only, arbitrage', kwp: 0, batt: 10, grid: true, exp: true, limit: 6 },
  { name: 'export disabled — surplus is curtailed', kwp: 8, batt: 5, grid: false, exp: false, limit: 6 },
  { name: 'export clipped by a tight limit', kwp: 12, batt: 0, grid: false, exp: true, limit: 2 },
  { name: 'an oversized array', kwp: 20, batt: 15, grid: true, exp: true, limit: 6 },
];

const SERIES = ['grid_import', 'grid_export', 'battery_charge', 'battery_discharge',
  'self_use', 'curtailed', 'cost', 'revenue', 'soc'] as const;

describe('the extracted dispatch loop reproduces the original exactly', () => {
  const cons = consProfile(4800);
  const wholesale = wholesaleProfile();

  for (const [planName, plan] of PLANS) {
    for (const c of CASES) {
      it(`${planName}, ${c.name}`, () => {
        const gen = genProfile(c.kwp);
        const state = { ...HOUSE, battery_kwh: c.batt, export_enabled: c.exp, export_limit_kw: c.limit };
        const strategy = { charge_from_grid: c.grid };

        const before = legacySimulate(plan, gen, cons, strategy, state, wholesale);
        const after = simulateDispatch(plan, gen, cons,
          batterySpec(c.batt, state.battery_min, state.battery_max, state.battery_eff),
          { chargeFromGrid: c.grid, exportEnabled: c.exp, exportLimitKw: c.limit, wholesale });

        for (const key of SERIES) {
          const a = before[key] as Float32Array;
          const b = after[key] as Float32Array;
          expect(b.length, `${key} changed length`).toBe(a.length);
          // Float32 arithmetic in the same order gives bit-identical results.
          // Anything else means the extraction changed the maths.
          let firstDiff = -1;
          for (let i = 0; i < a.length; i += 1) {
            if (a[i] !== b[i]) { firstDiff = i; break; }
          }
          expect(firstDiff, `${key} first differs at hour ${firstDiff}: `
            + `was ${a[firstDiff]}, now ${b[firstDiff]}`).toBe(-1);
        }
        expect(after.band).toEqual(before.band);
        expect(after.plan_id).toBe(before.plan_id);
      });
    }
  }
});

describe('the dispatch loop keeps its own books', () => {
  const cons = consProfile(4800);

  it('conserves energy every hour', () => {
    const gen = genProfile(6);
    const r = simulateDispatch(DAY_NIGHT, gen, cons, batterySpec(10),
      { chargeFromGrid: true, exportEnabled: true, exportLimitKw: 6 });
    const eff = Math.sqrt(0.9);
    for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
      // in = generation + import + what the battery gave back
      // out = consumption + export + what the battery took + what was clipped
      const into = (gen[i] ?? 0) + (r.grid_import[i] ?? 0) + (r.battery_discharge[i] ?? 0) * eff;
      const outOf = (cons[i] ?? 0) + (r.grid_export[i] ?? 0)
        + (r.battery_charge[i] ?? 0) + (r.curtailed[i] ?? 0);
      expect(Math.abs(into - outOf), `hour ${i} does not balance`).toBeLessThan(1e-3);
    }
  });

  it('never takes the battery outside its limits', () => {
    const r = simulateDispatch(SMART_EV, genProfile(6), cons, batterySpec(10),
      { chargeFromGrid: true, exportEnabled: true, exportLimitKw: 6 });
    for (let i = 0; i <= HOURS_IN_YEAR; i += 1) {
      expect(r.soc[i]).toBeGreaterThanOrEqual(1.0 - 1e-6);   // minSoc = 10% of 10 kWh
      expect(r.soc[i]).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it('earns nothing from export when the connection cannot export', () => {
    const r = simulateDispatch(FLAT, genProfile(10), cons, batterySpec(0),
      { chargeFromGrid: false, exportEnabled: false, exportLimitKw: 6 });
    let revenue = 0;
    let curtailed = 0;
    for (let i = 0; i < HOURS_IN_YEAR; i += 1) { revenue += r.revenue[i] ?? 0; curtailed += r.curtailed[i] ?? 0; }
    expect(revenue).toBe(0);
    expect(curtailed, 'surplus vanished instead of being recorded as clipped').toBeGreaterThan(0);
  });
});

/**
 * The one thing that is deliberately not identical.
 *
 * The old loop read `plan.rates.peak` to decide whether a surplus kWh was
 * worth more exported than stored. On a plan that declares no peak band that
 * is `undefined`, so the test became `exportRate > NaN` — false for every hour
 * of the year — and the battery hoarded surplus regardless of how well the
 * export rate paid.
 *
 * No plan in tariffs.json is shaped that way, so nothing on screen has ever
 * been wrong because of it. The design search is a different matter: it
 * evaluates plan-and-battery pairings the interface never put together, and a
 * silent "never export on this plan" would make a battery look better than it
 * is in exactly the comparison the whole product exists to get right.
 */
describe('a plan with no peak band', () => {
  it('used to refuse to export, however well export paid', () => {
    const cons = consProfile(4800);
    const gen = genProfile(8);
    // Export pays 40c; a stored kWh only ever displaces the 35c day rate. On
    // this plan every surplus kWh should be sold, not stored.
    const generous = { ...NO_PEAK, export_rate: 0.40 } as unknown as Tariff;
    const state = { ...HOUSE, battery_kwh: 10 };

    const before = legacySimulate(generous, gen, cons, { charge_from_grid: false }, state, null);
    const after = simulateDispatch(generous, gen, cons, batterySpec(10),
      { chargeFromGrid: false, exportEnabled: true, exportLimitKw: 6 });

    const sum = (a: Float32Array) => { let t = 0; for (let i = 0; i < a.length; i += 1) t += a[i] ?? 0; return t; };

    // Old: the comparison was `0.40 > NaN`, false for all 8,760 hours, so the
    // surplus went into the battery and the export never happened.
    expect(sum(before.battery_charge), 'the old loop did not hoard surplus').toBeGreaterThan(100);

    // New: the comparison is made, and export wins.
    expect(sum(after.grid_export), 'surplus is still not being sold')
      .toBeGreaterThan(sum(before.grid_export));
    expect(sum(after.battery_charge), 'surplus is still being hoarded')
      .toBeLessThan(sum(before.battery_charge));
    expect(sum(after.revenue)).toBeGreaterThan(sum(before.revenue));
  });

  it('is not a shape any real tariff has, so nothing on screen changes', async () => {
    const { default: file } = await import('../../public/tariffs.json');
    const plans = (file as any).plans ?? file;
    const peakless = (plans as any[]).filter((p) => p.rates && p.rates.peak == null);
    expect(peakless.map((p) => `${p.supplier} — ${p.plan}`)).toEqual([]);
  });
});

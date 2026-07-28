/**
 * Hour-by-hour battery dispatch over a year.
 *
 * This is the expensive part of the whole application — 8,760 iterations of
 * decide-store-or-export, decide-discharge-or-import — and until now it lived
 * inside the UI module and read the eleven values it needed straight off the
 * global `state` object.
 *
 * That was tolerable while one system was simulated at a time. It is not
 * tolerable for a search: to answer "what SHOULD you install?" the engine has
 * to evaluate hundreds of systems, and a function that can only describe the
 * one system currently on screen cannot be pointed at a hypothetical one, run
 * off the main thread, or tested without booting an application.
 *
 * So the inputs are arguments now. The arithmetic is unchanged, deliberately
 * and provably: `dispatch-parity.test.ts` runs this against the original
 * implementation and requires every one of the 8,760 hours to match exactly.
 * A search that quietly disagrees with the screen it is advising about would
 * be worse than no search at all.
 */

import { HOURS_IN_YEAR, type Band, type Tariff } from './constants.js';
import { bandAt, rateAt } from './tariff-rules.js';

/** The battery, or its absence. `capacityKwh: 0` is a home without one. */
export interface BatterySpec {
  /** Usable capacity, kWh. */
  capacityKwh: number;
  /** Floor, as a fraction of capacity — the part never discharged. */
  minSoc: number;
  /** Ceiling, as a fraction of capacity. */
  maxSoc: number;
  /** Round-trip efficiency, 0–1. The square root is applied in each direction. */
  roundTripEff: number;
  /** Inverter charge limit, kW. */
  maxChargeKw: number;
  /** Inverter discharge limit, kW. */
  maxDischargeKw: number;
}

export const DEFAULT_INVERTER_KW = 5.0;

export function batterySpec(
  capacityKwh: number,
  minSoc = 0.1,
  maxSoc = 1.0,
  roundTripEff = 0.9,
): BatterySpec {
  return {
    capacityKwh,
    minSoc,
    maxSoc,
    roundTripEff,
    maxChargeKw: DEFAULT_INVERTER_KW,
    maxDischargeKw: DEFAULT_INVERTER_KW,
  };
}

export interface DispatchOptions {
  /** Arbitrage: fill the battery from the grid during cheap windows. */
  chargeFromGrid: boolean;
  /** Whether the connection is allowed to export at all. */
  exportEnabled: boolean;
  /** Export cap, kW. Surplus above it is curtailed — clipped, not earned. */
  exportLimitKw: number;
  /** Hourly wholesale adder for dynamic plans; null for everything else. */
  wholesale?: Float32Array | null;
}

export interface DispatchResult {
  gen: Float32Array;
  cons: Float32Array;
  soc: Float32Array;
  grid_import: Float32Array;
  grid_export: Float32Array;
  battery_charge: Float32Array;
  battery_discharge: Float32Array;
  self_use: Float32Array;
  curtailed: Float32Array;
  cost: Float32Array;
  revenue: Float32Array;
  band: Band[];
  eff_rate: Float32Array | null;
  plan_id: string;
}

export function simulateDispatch(
  plan: Tariff,
  gen: Float32Array,
  cons: Float32Array,
  battery: BatterySpec,
  options: DispatchOptions,
): DispatchResult {
  const cap = battery.capacityKwh || 0;
  const minSoc = battery.minSoc * cap;
  const maxSoc = (battery.maxSoc || 1.0) * cap;
  const eff = Math.sqrt(battery.roundTripEff);   // applied each way
  const maxChargeKw = battery.maxChargeKw;
  const maxDischargeKw = battery.maxDischargeKw;
  const isDynamic = plan.type === 'dynamic';
  const wholesale = options.wholesale ?? null;

  // For dynamic tariffs: pre-compute effective rates for the year.
  let effRates: Float32Array | null = null;
  if (isDynamic) {
    effRates = new Float32Array(HOURS_IN_YEAR);
    for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
      effRates[i] = rateAt(i % 24, plan, i, wholesale);
    }
  }

  const out: DispatchResult = {
    gen,
    cons,
    soc: new Float32Array(HOURS_IN_YEAR + 1),
    grid_import: new Float32Array(HOURS_IN_YEAR),
    grid_export: new Float32Array(HOURS_IN_YEAR),
    battery_charge: new Float32Array(HOURS_IN_YEAR),
    battery_discharge: new Float32Array(HOURS_IN_YEAR),
    self_use: new Float32Array(HOURS_IN_YEAR),
    curtailed: new Float32Array(HOURS_IN_YEAR),
    cost: new Float32Array(HOURS_IN_YEAR),
    revenue: new Float32Array(HOURS_IN_YEAR),
    band: new Array(HOURS_IN_YEAR),
    eff_rate: effRates,
    plan_id: plan.id,
  };

  let soc = minSoc + 0.3 * (cap - minSoc);   // start at 30% above min
  const exportRate = plan.export_rate ?? 0;
  // The value the battery is holding surplus *for*: what a stored kWh will
  // displace when it comes back out. On a plan with no declared peak band that
  // is the day rate.
  //
  // This is the one deliberate difference from the pre-extraction loop, which
  // read plan.rates.peak alone. On such a plan that is `undefined`, so the
  // comparison below became `exportRate > NaN` — false, always — and the
  // battery charged from surplus no matter how good the export rate was.
  // Nothing in the tariff file triggers it today: all 27 plans declare a peak
  // rate. But the design search invents plan/battery pairings the screen never
  // showed, and a search that silently stops exporting on one plan shape would
  // recommend a battery for the wrong reason.
  const peakRate = plan.rates.peak ?? plan.rates.day ?? 0;

  const exportEnabled = options.exportEnabled !== false;
  const exportLimit = exportEnabled ? (options.exportLimitKw || 999) : 0;

  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    out.soc[i] = soc;
    const hour = i % 24;
    const g = gen[i] ?? 0;
    const c = cons[i] ?? 0;
    const band = bandAt(hour, plan);
    out.band[i] = band;
    const rate = isDynamic && effRates
      ? (effRates[i] ?? 0)
      : (plan.rates[band] ?? plan.rates.day ?? 0);

    // For dynamic, is THIS hour cheap or dear relative to the coming 24?
    let isCheapDynamic = false;
    let isExpensiveDynamic = false;
    let dailyAvg = 0;
    if (isDynamic && effRates) {
      let sum = 0;
      let n = 0;
      for (let k = 0; k < 24 && i + k < HOURS_IN_YEAR; k += 1) { sum += effRates[i + k] ?? 0; n += 1; }
      dailyAvg = n > 0 ? sum / n : rate;
      isCheapDynamic = rate < dailyAvg * 0.65;
      isExpensiveDynamic = rate > dailyAvg * 1.40;
    }

    const netSolarAfterLoad = g - c;      // positive = surplus
    out.self_use[i] = Math.min(g, c);

    let charge = 0;
    let discharge = 0;
    let imp = 0;
    let exp = 0;

    if (netSolarAfterLoad > 0) {
      // Surplus. Store it or sell it.
      const headroom = maxSoc - soc;
      const canStore = Math.min(headroom / eff, maxChargeKw, netSolarAfterLoad);
      const expectedDischargeValue = isDynamic ? dailyAvg * 1.5 : (peakRate ?? 0);
      if (exportEnabled && exportRate * 1.0 > expectedDischargeValue * eff * eff) {
        exp = netSolarAfterLoad;
      } else {
        charge = canStore;
        soc += charge * eff;
        exp = Math.max(0, netSolarAfterLoad - charge);
      }
      if (exp > exportLimit) {
        out.curtailed[i] = exp - exportLimit;
        exp = exportLimit;
      }
    } else if (netSolarAfterLoad < 0) {
      const deficit = -netSolarAfterLoad;

      const isCheapWindow = isDynamic
        ? isCheapDynamic
        : ((band === 'ev') || (band === 'night' && rate <= 0.20));

      const isExpensiveWindow = isDynamic
        ? isExpensiveDynamic
        : (band === 'peak' || band === 'day');

      if (isExpensiveWindow && !isCheapWindow) {
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw);
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - dis * eff);
      } else if (isCheapWindow) {
        if (options.chargeFromGrid) {
          const headroom = maxSoc - soc;
          const chargeAmt = Math.min(headroom / eff, maxChargeKw);
          charge = chargeAmt;
          soc += chargeAmt * eff;
          imp = deficit + charge;
        } else {
          imp = deficit;
        }
      } else {
        // Neutral hour — half-rate discharge to meet load, else import.
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw * 0.5);
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - dis * eff);
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

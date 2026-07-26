/**
 * Discounted cash-flow model for a solar + battery install over 20 years.
 *
 * This is the number a user weighs a €12k purchase against, so the assumptions
 * are named rather than inlined as magic numbers.
 */

/** Real discount rate applied to future savings. */
export const DEFAULT_DISCOUNT_RATE = 0.03;
/** Annual panel output degradation. Industry typical for modern N-type. */
export const DEFAULT_PANEL_DEGRADATION = 0.005;
/** Replacement cost per kWh of battery capacity, euro. */
export const BATTERY_REPLACEMENT_EUR_PER_KWH = 400;
/** Year in which a battery is assumed to need replacing. */
export const BATTERY_REPLACEMENT_YEAR = 12;
/** Horizon of the model, years. */
export const HORIZON_YEARS = 20;

export interface NpvInputs {
  /** First-year benefit, euro. Degrades each subsequent year. */
  annualBenefit: number;
  /** Install cost after grant, euro. Spent at year 0. */
  sysCostNet: number;
  /** Battery capacity, kWh. Zero means no replacement cost is modelled. */
  batteryKwh: number;
  panelDegradation?: number;
  discountRate?: number;
}

export interface NpvYear {
  year: number;
  /** Benefit in that year before discounting, euro. */
  undiscounted: number;
  /** Benefit discounted back to today, euro. */
  discounted: number;
  /** Negative in the battery replacement year, otherwise zero. */
  batteryCost: number;
  /** Running total including the year-0 outlay, euro. */
  cumulative: number;
}

/** Year-by-year cash flow. `npv20()` is the total of the final row. */
export function npvSchedule(inputs: NpvInputs): NpvYear[] {
  const r = inputs.discountRate ?? DEFAULT_DISCOUNT_RATE;
  const deg = inputs.panelDegradation ?? DEFAULT_PANEL_DEGRADATION;
  const rows: NpvYear[] = [];
  let cumulative = -inputs.sysCostNet;

  for (let year = 1; year <= HORIZON_YEARS; year += 1) {
    const undiscounted = inputs.annualBenefit * Math.pow(1 - deg, year - 1);
    const discounted = undiscounted / Math.pow(1 + r, year);
    const batteryCost = inputs.batteryKwh > 0 && year === BATTERY_REPLACEMENT_YEAR
      ? -(BATTERY_REPLACEMENT_EUR_PER_KWH * inputs.batteryKwh) / Math.pow(1 + r, year)
      : 0;
    cumulative += discounted + batteryCost;
    rows.push({ year, undiscounted, discounted, batteryCost, cumulative });
  }
  return rows;
}

/** Net present value over the 20-year horizon, euro. */
export function npv20(inputs: NpvInputs): number {
  const r = inputs.discountRate ?? DEFAULT_DISCOUNT_RATE;
  const deg = inputs.panelDegradation ?? DEFAULT_PANEL_DEGRADATION;
  let value = -inputs.sysCostNet;
  for (let year = 1; year <= HORIZON_YEARS; year += 1) {
    value += (inputs.annualBenefit * Math.pow(1 - deg, year - 1)) / Math.pow(1 + r, year);
  }
  if (inputs.batteryKwh > 0) {
    value -= (BATTERY_REPLACEMENT_EUR_PER_KWH * inputs.batteryKwh)
      / Math.pow(1 + r, BATTERY_REPLACEMENT_YEAR);
  }
  return value;
}

/**
 * First year in which cumulative discounted cash flow turns non-negative,
 * or null if it never does inside the horizon.
 */
export function breakevenYear(inputs: NpvInputs): number | null {
  const idx = npvSchedule(inputs).findIndex((row) => row.cumulative >= 0);
  return idx < 0 ? null : idx + 1;
}

/** Shared constants and domain shapes for the calculation engine. */

export const HOURS_IN_YEAR = 8760;
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
export const DEG = Math.PI / 180;

/**
 * A climate/irradiance profile for one location. Monthly arrays are indexed
 * 0 = January .. 11 = December.
 *
 * The engine takes this as a parameter rather than reading a module global, so
 * a caller can simulate any location — and so tests can pin a fixed profile
 * instead of depending on whichever region the user last selected.
 */
export interface LocationProfile {
  lat: number;
  lon: number;
  /** Monthly mean daily global horizontal irradiance, kWh/m²/day. */
  ghi_kwh_m2_day: readonly number[];
  /** Monthly clearness index, used by the Erbs diffuse split. */
  kt: readonly number[];
  /** Monthly mean ambient temperature, °C. Drives the NOCT cell derate. */
  temp_c: readonly number[];
}

/** Irish national baseline: Dublin lat/lon with PVGIS-aligned irradiance. */
export const LOCATION_BASE: LocationProfile = {
  lat: 53.35,
  lon: -6.26,
  ghi_kwh_m2_day: [0.70, 1.25, 2.35, 3.55, 4.45, 4.65, 4.40, 3.75, 2.80, 1.60, 0.80, 0.55],
  kt: [0.32, 0.36, 0.39, 0.42, 0.44, 0.45, 0.43, 0.42, 0.40, 0.36, 0.32, 0.30],
  temp_c: [6.0, 6.0, 7.0, 9.0, 11.5, 14.0, 15.5, 15.5, 13.5, 11.0, 8.0, 6.5],
};

/** Scale a location's irradiance by a regional multiplier (PVGIS-calibrated). */
export function withGhiMultiplier(base: LocationProfile, multiplier: number): LocationProfile {
  return { ...base, ghi_kwh_m2_day: base.ghi_kwh_m2_day.map((v) => v * multiplier) };
}

/** Day of year, 1-365, for a zero-based month index and 1-based day. */
export function dayOfYear(monthIdx: number, day: number): number {
  let n = 0;
  for (let i = 0; i < monthIdx; i += 1) n += DAYS_IN_MONTH[i] ?? 0;
  return n + day;
}

/** Tariff rate bands. `day` is the fallback when no window matches. */
export type Band = 'day' | 'night' | 'peak' | 'ev' | 'wfh';

/** An inclusive-start, exclusive-end hour window. May wrap past midnight. */
export type HourWindow = readonly [number, number];

/**
 * An announced-but-not-yet-effective price change.
 *
 * Irish suppliers must give notice before a price move, so an increase is
 * public weeks before it takes effect. The rates on the plan are still today's
 * real rates; this records what is coming so the app can both warn the reader
 * and cost the plan over the year they would actually hold it, rather than on a
 * price about to disappear.
 */
export interface PriceChange {
  /** ISO date the new rates take effect. */
  effective_date: string;
  /**
   * Fractional change to unit rates, e.g. 0.07 for +7%. Signed. Applied to
   * every band unless `pct_bands` overrides per band. Irish increases are
   * rarely uniform — a night rate can jump 28% while the day rate moves 3% —
   * so a plan whose value is its cheap night band should carry `pct_bands`.
   */
  pct: number;
  /** Per-band fractional change, overriding `pct` for the bands it names. */
  pct_bands?: Partial<Record<Band, number>>;
  /** Fractional change to the standing charge, if separately announced. */
  standing_pct?: number;
  direction?: 'increase' | 'decrease';
  source?: string;
  note?: string;
}

export interface Tariff {
  id: string;
  supplier: string;
  plan: string;
  type: string;
  standing: number;
  export_rate?: number;
  discontinued?: boolean;
  verified_date?: string;
  price_change?: PriceChange;
  rates: Partial<Record<Band, number>>;
  windows: Partial<Record<Exclude<Band, 'day'>, HourWindow>>;
}

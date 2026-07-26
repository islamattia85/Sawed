/**
 * Branded unit types for the calculation engine.
 *
 * The engine passes bare `number`s between ~40 functions where the unit is
 * carried only by a variable name. The mistakes that actually happen in this
 * codebase are unit confusions:
 *
 *   - energy (kWh) vs power (kW)                — the Day Inspector chart shipped
 *                                                 with a half-hourly kWh series
 *                                                 plotted as if it were kW
 *   - euro vs cent                              — tariff rates are stored in
 *                                                 cents, bills in euro
 *   - annual vs bimonthly vs per-period figures — bills are bimonthly, savings
 *                                                 are annual, and both appear
 *                                                 in the same sentences
 *
 * A brand makes those distinctions checkable at compile time while erasing to a
 * plain number at runtime — no wrapper objects, no arithmetic cost.
 *
 * Construct with the helpers below at the boundary where a raw number enters
 * the engine; inside the engine, pass branded values around.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Energy, kilowatt-hours. */
export type Kwh = Brand<number, 'kWh'>;
/** Power, kilowatts. Instantaneous or averaged over a stated interval. */
export type Kw = Brand<number, 'kW'>;
/** Money, euro. */
export type Eur = Brand<number, 'EUR'>;
/** Money, cents. Tariff unit rates are stored in cents per kWh. */
export type Cent = Brand<number, 'cent'>;
/** Peak capacity of a PV array, kilowatt-peak. */
export type Kwp = Brand<number, 'kWp'>;
/** A fraction in [0, 1]. Not a percentage. */
export type Ratio = Brand<number, 'ratio'>;
/** Hour of day, 0-23. */
export type Hour = Brand<number, 'hour'>;

export const kwh = (n: number): Kwh => n as Kwh;
export const kw = (n: number): Kw => n as Kw;
export const eur = (n: number): Eur => n as Eur;
export const cent = (n: number): Cent => n as Cent;
export const kwp = (n: number): Kwp => n as Kwp;
export const ratio = (n: number): Ratio => n as Ratio;
export const hour = (n: number): Hour => n as Hour;

/** Cents to euro. The engine stores rates in cents and reports totals in euro. */
export const centToEur = (c: Cent): Eur => ((c as number) / 100) as unknown as Eur;

/** Euro to cents. */
export const eurToCent = (e: Eur): Cent => ((e as number) * 100) as unknown as Cent;

/**
 * Convert an energy reading over an interval into average power.
 * A half-hourly meter reading of 0.34 kWh is 0.68 kW, not 0.34 kW.
 */
export const kwhOverHoursToKw = (energy: Kwh, hours: number): Kw =>
  ((energy as number) / hours) as unknown as Kw;

/** Average power sustained for a number of hours, as energy. */
export const kwForHoursToKwh = (power: Kw, hours: number): Kwh =>
  ((power as number) * hours) as unknown as Kwh;

/** Irish bills are issued every two months: six billing periods per year. */
export const BILLING_PERIODS_PER_YEAR = 6;

/** A bimonthly amount expressed as an annual one. */
export const bimonthlyToAnnual = (amount: Eur): Eur =>
  ((amount as number) * BILLING_PERIODS_PER_YEAR) as unknown as Eur;

/** An annual amount expressed as a bimonthly one. */
export const annualToBimonthly = (amount: Eur): Eur =>
  ((amount as number) / BILLING_PERIODS_PER_YEAR) as unknown as Eur;

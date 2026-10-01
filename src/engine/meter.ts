/**
 * Real meter readings, costed.
 *
 * The rest of the engine works on a modelled year. This works on what the
 * ESB meter actually recorded: for each day, the kWh bought from the grid in
 * each hour and the kWh sent back. With it the app can answer what the model
 * can only estimate: what a plan really cost this home, what a switch really
 * saved, and how well the home's use fits its plan's cheap hours.
 *
 * Dynamic plans are costed at their fixed base rate; the wholesale part is
 * not known for past hours here.
 */
import { PSO_LEVY, YEAR_START_WEEKDAY, type Tariff } from './constants.js';
import { bandAt, staticRateAt } from './tariff-rules.js';

/** One day: 24 hourly import kWh, then 24 hourly export kWh. Keyed YYYY-MM-DD. */
export type MeterDays = Record<string, number[]>;

const DAY = 864e5;

/** An hour of the modelled year that falls on the same weekday as `date`. */
export function hourIdxFor(date: string, hour: number): number {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;   // 0 = Monday
  const d = (dow - YEAR_START_WEEKDAY + 7) % 7;
  return d * 24 + hour;
}

export interface MeterCost { days: number; importKwh: number; exportKwh: number; energy: number; credit: number; standing: number; total: number }

/** What `plan` would have charged for the recorded days in [from, to). */
export function costOn(days: MeterDays, plan: Tariff, from = '0000-00-00', to = '9999-99-99'): MeterCost {
  let n = 0, imp = 0, exp = 0, energy = 0, credit = 0;
  for (const [date, v] of Object.entries(days)) {
    if (date < from || date >= to || !v || v.length < 48) continue;
    n++;
    for (let h = 0; h < 24; h++) {
      const i = v[h] || 0, e = v[24 + h] || 0;
      imp += i; exp += e;
      energy += i * staticRateAt(hourIdxFor(date, h), plan);
      credit += e * (plan.export_rate || 0);
    }
  }
  const standing = (plan.standing + PSO_LEVY) * n / 365;
  return { days: n, importKwh: imp, exportKwh: exp, energy, credit, standing, total: energy - credit + standing };
}

export interface SwitchCheck { days: number; real: number; perYear: number; expected: number; ratio: number | null }

/**
 * A switch, checked against the meter: the same recorded use, priced on the
 * old plan and on the new one, from the switch date on. Needs two weeks.
 */
export function checkSwitch(days: MeterDays, ev: { at: string; per_year: number }, from: Tariff, to: Tariff): SwitchCheck | null {
  const a = costOn(days, to, ev.at), b = costOn(days, from, ev.at);
  if (a.days < 14) return null;
  const real = b.total - a.total;
  const perYear = real * 365 / a.days;
  return { days: a.days, real, perYear, expected: ev.per_year, ratio: ev.per_year > 0 ? perYear / ev.per_year : null };
}

/**
 * How well the recorded use fits the plan's prices: 1 when every kWh was
 * bought at the plan's cheapest rate, 0 when all at its dearest. Null on a
 * plan with one price, where timing cannot matter.
 */
export function timingFit(days: MeterDays, plan: Tariff, from = '0000-00-00'): { fit: number; avgRate: number; peakShare: number } | null {
  let kwh = 0, paid = 0, peak = 0, cheap = Infinity, dear = 0;
  for (let i = 0; i < 168; i++) { const r = staticRateAt(i, plan); cheap = Math.min(cheap, r); dear = Math.max(dear, r); }
  for (const [date, v] of Object.entries(days)) {
    if (date < from || !v) continue;
    for (let h = 0; h < 24; h++) {
      const x = v[h] || 0;
      kwh += x;
      paid += x * staticRateAt(hourIdxFor(date, h), plan);
      if (bandAt(h, plan) === 'peak') peak += x;
    }
  }
  if (kwh <= 0) return null;
  const avgRate = paid / kwh;
  if (dear - cheap < 0.01) return { fit: 1, avgRate, peakShare: peak / kwh };
  return { fit: Math.max(0, Math.min(1, (dear - avgRate) / (dear - cheap))), avgRate, peakShare: peak / kwh };
}

/** The recorded range, and how many days fall in it. */
export function meterRange(days: MeterDays): { from: string; to: string; days: number } | null {
  const keys = Object.keys(days).sort();
  if (!keys.length) return null;
  return { from: keys[0]!, to: keys[keys.length - 1]!, days: keys.length };
}

/** Days since an ISO date, by the calendar. */
export const daysSince = (iso: string, now = Date.now()) => Math.floor((now - Date.parse(`${iso}T00:00:00Z`)) / DAY);

import { describe, it, expect } from 'vitest';
import { costOn, checkSwitch, timingFit, hourIdxFor } from '../../src/engine/meter';
import { weekdayOf } from '../../src/engine/tariff-rules';
import type { Tariff } from '../../src/engine/constants';

const flat: Tariff = { id: 'F', supplier: 'A', plan: 'Flat', type: 'flat', standing: 0, export_rate: 0.2,
  rates: { day: 0.30, night: 0.30, peak: 0.30 }, windows: {} };
const tou: Tariff = { id: 'T', supplier: 'B', plan: 'Night', type: 'tou', standing: 0, export_rate: 0.2,
  rates: { day: 0.35, night: 0.15, peak: 0.45 }, windows: { night: [23, 8], peak: [17, 19] } };

const dayOf = (imp: (h: number) => number, exp: (h: number) => number = () => 0) =>
  [...Array.from({ length: 24 }, (_, h) => imp(h)), ...Array.from({ length: 24 }, (_, h) => exp(h))];

describe('meter costing', () => {
  it('maps a real date to an hour of the modelled year on the same weekday', () => {
    // 2026-10-05 is a Monday.
    expect(weekdayOf(hourIdxFor('2026-10-05', 9))).toBe(0);
    expect(weekdayOf(hourIdxFor('2026-10-11', 9))).toBe(6);
  });

  it('prices each recorded hour at the plan rate and credits exports', () => {
    const days = { '2026-10-05': dayOf(() => 1, (h) => (h === 13 ? 2 : 0)) };
    const c = costOn(days, flat);
    expect(c.importKwh).toBe(24);
    expect(c.energy).toBeCloseTo(24 * 0.30);
    expect(c.credit).toBeCloseTo(2 * 0.2);
    expect(c.days).toBe(1);
  });

  it('a switch is checked on the same real use, from the switch date only', () => {
    const days: Record<string, number[]> = {};
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
      days[d] = dayOf((h) => (h < 7 ? 2 : 0.5));   // heavy night use
    }
    const r = checkSwitch(days, { at: '2026-09-05', per_year: 300 }, flat, tou)!;
    expect(r.days).toBe(16);
    expect(r.real).toBeGreaterThan(0);              // night use is cheaper on the night plan
    expect(r.perYear).toBeCloseTo(r.real * 365 / 16);
    expect(checkSwitch(days, { at: '2026-09-15', per_year: 300 }, flat, tou)).toBeNull();   // under two weeks
  });

  it('timing fit is 1 for use all at the cheapest hours, lower for peak use, and full on a flat plan', () => {
    const night = { '2026-10-05': dayOf((h) => (h < 7 ? 1 : 0)) };
    const peak = { '2026-10-05': dayOf((h) => (h === 17 || h === 18 ? 1 : 0)) };
    expect(timingFit(night, tou)!.fit).toBeCloseTo(1);
    expect(timingFit(peak, tou)!.fit).toBeCloseTo(0);
    expect(timingFit(peak, tou)!.peakShare).toBeCloseTo(1);
    expect(timingFit(peak, flat)!.fit).toBe(1);
  });
});

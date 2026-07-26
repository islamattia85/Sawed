import { describe, it, expect } from 'vitest';
import {
  monthlyBalance, monthBoundaries, dayProfile, bandBreakdown, batteryStats,
  yearSummary, importDurationCurve, peakConcentration, MONTH_NAMES,
  type HourlySim,
} from '../../src/engine/analysis.js';
import { HOURS_IN_YEAR, DAYS_IN_MONTH, type Band } from '../../src/engine/constants.js';

/** A synthetic year with a known shape, so every aggregate has a right answer. */
function makeSim(over: Partial<Record<keyof HourlySim, Float32Array | Band[]>> = {}): HourlySim {
  const z = () => new Float32Array(HOURS_IN_YEAR);
  const gen = z();
  const cons = z();
  const imp = z();
  const exp = z();
  const self = z();
  const cost = z();

  for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
    const hour = i % 24;
    const doy = Math.floor(i / 24);
    // Sinusoidal seasonal generation, daylight hours only. Peaks at midsummer.
    const seasonal = 0.5 + 0.5 * Math.cos(((doy - 172) / 365) * 2 * Math.PI);
    gen[i] = hour >= 8 && hour < 17 ? 2 * seasonal : 0;
    cons[i] = 0.5;
    self[i] = Math.min(gen[i]!, cons[i]!);
    imp[i] = Math.max(0, cons[i]! - gen[i]!);
    exp[i] = Math.max(0, gen[i]! - cons[i]!);
    cost[i] = imp[i]! * 0.35;
  }

  return {
    gen, cons, grid_import: imp, grid_export: exp, self_use: self,
    battery_charge: z(), battery_discharge: z(), soc: z(),
    cost, revenue: z(),
    band: new Array<Band>(HOURS_IN_YEAR).fill('day'),
    ...(over as Partial<HourlySim>),
  };
}

describe('monthBoundaries', () => {
  it('covers exactly one year', () => {
    const b = monthBoundaries();
    expect(b).toHaveLength(13);
    expect(b[0]).toBe(0);
    expect(b[12]).toBe(HOURS_IN_YEAR);
  });

  it('each span matches the length of its month', () => {
    const b = monthBoundaries();
    for (let m = 0; m < 12; m += 1) {
      expect(b[m + 1]! - b[m]!).toBe((DAYS_IN_MONTH[m] ?? 0) * 24);
    }
  });
});

describe('monthlyBalance', () => {
  const rows = monthlyBalance(makeSim());

  it('returns a row per month, in order', () => {
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.month)).toEqual([...MONTH_NAMES]);
  });

  it('conserves energy: month totals equal the annual total', () => {
    const sim = makeSim();
    const annual = (a: Float32Array) => a.reduce((x, v) => x + v, 0);
    expect(rows.reduce((a, r) => a + r.generated, 0)).toBeCloseTo(annual(sim.gen), 3);
    expect(rows.reduce((a, r) => a + r.consumed, 0)).toBeCloseTo(annual(sim.cons), 3);
    expect(rows.reduce((a, r) => a + r.imported, 0)).toBeCloseTo(annual(sim.grid_import), 3);
  });

  it('generates more in June than in December', () => {
    expect(rows[5]!.generated).toBeGreaterThan(rows[11]!.generated * 3);
  });

  it('reports ratios as fractions inside [0, 1]', () => {
    for (const r of rows) {
      expect(r.selfSufficiency).toBeGreaterThanOrEqual(0);
      expect(r.selfSufficiency).toBeLessThanOrEqual(1);
      expect(r.selfConsumption).toBeGreaterThanOrEqual(0);
      expect(r.selfConsumption).toBeLessThanOrEqual(1);
    }
  });

  it('self-sufficiency is higher in summer than in winter', () => {
    expect(rows[5]!.selfSufficiency).toBeGreaterThan(rows[11]!.selfSufficiency);
  });

  it('self-consumption is higher in winter, when little is spare to export', () => {
    expect(rows[11]!.selfConsumption).toBeGreaterThan(rows[5]!.selfConsumption);
  });

  it('self-use is generation that did not leave, never more than generation', () => {
    for (const r of rows) {
      expect(r.selfUsed).toBeLessThanOrEqual(r.generated + 1e-6);
      expect(r.selfUsed).toBeCloseTo(Math.max(0, r.generated - r.exported), 3);
    }
  });

  /**
   * The defect this guards: on an arbitrage plan the dispatcher charges the
   * battery from the grid overnight, and that energy lands in grid_import.
   * Counting it as load made self-sufficiency read about a third too low.
   */
  it('excludes grid-charging from the import that counts against self-sufficiency', () => {
    const charge = new Float32Array(HOURS_IN_YEAR);
    const imp = new Float32Array(HOURS_IN_YEAR);
    const cons = new Float32Array(HOURS_IN_YEAR).fill(0.5);
    for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
      // 03:00 every night: charge 4 kWh from the grid on top of the load.
      if (i % 24 === 3) { charge[i] = 4; imp[i] = 4.5; } else { imp[i] = 0.5; }
    }
    const withArb = monthlyBalance(makeSim({
      gen: new Float32Array(HOURS_IN_YEAR), cons, grid_import: imp,
      battery_charge: charge, self_use: new Float32Array(HOURS_IN_YEAR),
      grid_export: new Float32Array(HOURS_IN_YEAR),
    }));
    for (const r of withArb) {
      // All of the extra import was battery charging, none of it load.
      expect(r.importedToBattery).toBeGreaterThan(0);
      expect(r.importedToBattery).toBeCloseTo(r.imported - r.consumed, 1);
      // Load was met entirely from the grid here, so self-sufficiency is 0 —
      // not a negative number, and not distorted by the charging.
      expect(r.selfSufficiency).toBeCloseTo(0, 2);
    }
  });

  it('attributes charging to solar when there is surplus to charge from', () => {
    const gen = new Float32Array(HOURS_IN_YEAR);
    const charge = new Float32Array(HOURS_IN_YEAR);
    const cons = new Float32Array(HOURS_IN_YEAR).fill(0.5);
    for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
      if (i % 24 === 12) { gen[i] = 5; charge[i] = 4; } // surplus 4.5, charge 4
    }
    const rows2 = monthlyBalance(makeSim({
      gen, cons, battery_charge: charge,
      grid_import: new Float32Array(HOURS_IN_YEAR).fill(0.5),
      grid_export: new Float32Array(HOURS_IN_YEAR),
      self_use: new Float32Array(HOURS_IN_YEAR),
    }));
    for (const r of rows2) expect(r.importedToBattery).toBeCloseTo(0, 6);
  });

  it('handles a home with no generation at all', () => {
    const dark = monthlyBalance(makeSim({ gen: new Float32Array(HOURS_IN_YEAR) }));
    for (const r of dark) {
      expect(r.selfConsumption).toBe(0);
      expect(Number.isFinite(r.selfSufficiency)).toBe(true);
    }
  });
});

describe('dayProfile', () => {
  const sim = makeSim();

  it('returns 24 values for every series', () => {
    const p = dayProfile(sim, 171, 'Midsummer');
    for (const k of ['generation', 'consumption', 'gridImport', 'gridExport', 'soc'] as const) {
      expect(p[k]).toHaveLength(24);
    }
  });

  it('is dark before dawn and after dusk', () => {
    const p = dayProfile(sim, 171, 'Midsummer');
    expect(p.generation[3]).toBe(0);
    expect(p.generation[22]).toBe(0);
    expect(p.generation[12]).toBeGreaterThan(0);
  });

  it('midsummer out-generates midwinter', () => {
    expect(dayProfile(sim, 171, 'S').peakGeneration)
      .toBeGreaterThan(dayProfile(sim, 18, 'W').peakGeneration);
  });

  it('clamps an out-of-range day rather than reading past the array', () => {
    expect(() => dayProfile(sim, -5, 'x')).not.toThrow();
    expect(() => dayProfile(sim, 999, 'x')).not.toThrow();
    expect(dayProfile(sim, 999, 'x').generation).toHaveLength(24);
  });

  it('normalises state of charge against capacity', () => {
    const soc = new Float32Array(HOURS_IN_YEAR).fill(2.5);
    const p = dayProfile(makeSim({ soc }), 100, 'x', 5);
    expect(p.soc[0]).toBeCloseTo(0.5, 6);
  });

  it('reports zero state of charge when there is no battery', () => {
    expect(dayProfile(sim, 100, 'x', 0).soc.every((v) => v === 0)).toBe(true);
  });
});

describe('bandBreakdown', () => {
  it('splits import cost across the bands that occur', () => {
    const band = new Array<Band>(HOURS_IN_YEAR);
    for (let i = 0; i < HOURS_IN_YEAR; i += 1) {
      band[i] = (i % 24) >= 23 || (i % 24) < 8 ? 'night' : 'day';
    }
    const rows = bandBreakdown(makeSim({ band }));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.band).sort()).toEqual(['day', 'night']);
    // 9 night hours a day.
    expect(rows.find((r) => r.band === 'night')!.hours).toBe(9 * 365);
  });

  it('is sorted by cost, dearest first', () => {
    const rows = bandBreakdown(makeSim());
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.cost).toBeLessThanOrEqual(rows[i - 1]!.cost);
    }
  });

  it('derives an effective rate that matches cost over kWh', () => {
    for (const r of bandBreakdown(makeSim())) {
      expect(r.effectiveRate).toBeCloseTo(r.cost / r.kwh, 6);
    }
  });
});

describe('batteryStats', () => {
  it('returns null with no battery', () => {
    expect(batteryStats(makeSim(), 0)).toBeNull();
  });

  it('counts equivalent cycles from discharge throughput', () => {
    const dis = new Float32Array(HOURS_IN_YEAR);
    for (let i = 0; i < 365; i += 1) dis[i * 24 + 19] = 5; // one full 5 kWh cycle a day
    const s = batteryStats(makeSim({ battery_discharge: dis }), 5)!;
    expect(s.equivalentCycles).toBeCloseTo(365, 3);
  });

  it('measures achieved round-trip efficiency', () => {
    const ch = new Float32Array(HOURS_IN_YEAR).fill(1);
    const dis = new Float32Array(HOURS_IN_YEAR).fill(0.9);
    const s = batteryStats(makeSim({ battery_charge: ch, battery_discharge: dis }), 5)!;
    expect(s.roundTripEfficiency).toBeCloseTo(0.9, 6);
  });

  it('counts hours spent full and empty', () => {
    const soc = new Float32Array(HOURS_IN_YEAR);
    for (let i = 0; i < HOURS_IN_YEAR; i += 1) soc[i] = i % 2 === 0 ? 5 : 0;
    const s = batteryStats(makeSim({ soc }), 5)!;
    expect(s.hoursFull).toBe(HOURS_IN_YEAR / 2);
    expect(s.hoursEmpty).toBe(HOURS_IN_YEAR / 2);
  });
});

describe('yearSummary', () => {
  const rows = monthlyBalance(makeSim());
  const s = yearSummary(rows, 5);

  it('computes specific yield per kWp', () => {
    expect(s.specificYield).toBeCloseTo(s.generated / 5, 6);
  });

  it('identifies the best and worst months', () => {
    expect(s.bestMonth).toBe('Jun');
    expect(['Dec', 'Jan']).toContain(s.worstMonth);
  });

  it('reports a seasonal swing greater than one', () => {
    expect(s.seasonalSwing).toBeGreaterThan(1);
  });

  it('keeps ratios inside [0, 1]', () => {
    expect(s.selfSufficiency).toBeGreaterThanOrEqual(0);
    expect(s.selfSufficiency).toBeLessThanOrEqual(1);
    expect(s.selfConsumption).toBeGreaterThanOrEqual(0);
    expect(s.selfConsumption).toBeLessThanOrEqual(1);
  });

  it('survives a zero-kWp system', () => {
    expect(yearSummary(rows, 0).specificYield).toBe(0);
  });
});

describe('importDurationCurve', () => {
  it('is monotonically non-increasing', () => {
    const c = importDurationCurve(makeSim());
    for (let i = 1; i < c.length; i += 1) expect(c[i]!).toBeLessThanOrEqual(c[i - 1]! + 1e-9);
  });

  it('returns the requested number of buckets', () => {
    expect(importDurationCurve(makeSim(), 12)).toHaveLength(12);
  });
});

describe('peakConcentration', () => {
  it('is 1 when all cost falls in one hour', () => {
    const cost = new Float32Array(HOURS_IN_YEAR);
    cost[0] = 100;
    expect(peakConcentration(makeSim({ cost }), 0.1)).toBeCloseTo(1, 6);
  });

  it('equals the sampled share when cost is perfectly flat', () => {
    const cost = new Float32Array(HOURS_IN_YEAR).fill(1);
    expect(peakConcentration(makeSim({ cost }), 0.1)).toBeCloseTo(0.1, 2);
  });

  it('is zero when nothing is spent', () => {
    expect(peakConcentration(makeSim({ cost: new Float32Array(HOURS_IN_YEAR) }))).toBe(0);
  });
});

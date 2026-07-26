import { describe, it, expect } from 'vitest';
import {
  npv20, npvSchedule, breakevenYear,
  DEFAULT_DISCOUNT_RATE, BATTERY_REPLACEMENT_EUR_PER_KWH,
  BATTERY_REPLACEMENT_YEAR, HORIZON_YEARS,
} from '../../src/engine/npv.js';

const base = { annualBenefit: 1000, sysCostNet: 8000, batteryKwh: 0 };

describe('npv20', () => {
  it('subtracts the up-front cost', () => {
    expect(npv20({ ...base, annualBenefit: 0 })).toBe(-8000);
  });

  it('discounts future benefit below its face value', () => {
    const undiscounted = 1000 * HORIZON_YEARS - 8000;
    expect(npv20(base)).toBeLessThan(undiscounted);
  });

  it('matches a hand-computed flat annuity when degradation is off', () => {
    const r = DEFAULT_DISCOUNT_RATE;
    let expected = -8000;
    for (let y = 1; y <= 20; y += 1) expected += 1000 / Math.pow(1 + r, y);
    expect(npv20({ ...base, panelDegradation: 0 })).toBeCloseTo(expected, 6);
  });

  it('a higher discount rate lowers NPV', () => {
    expect(npv20({ ...base, discountRate: 0.08 }))
      .toBeLessThan(npv20({ ...base, discountRate: 0.01 }));
  });

  it('faster degradation lowers NPV', () => {
    expect(npv20({ ...base, panelDegradation: 0.02 }))
      .toBeLessThan(npv20({ ...base, panelDegradation: 0.002 }));
  });

  it('charges battery replacement once, discounted to its year', () => {
    const withBatt = npv20({ ...base, batteryKwh: 10 });
    const cost = (BATTERY_REPLACEMENT_EUR_PER_KWH * 10)
      / Math.pow(1 + DEFAULT_DISCOUNT_RATE, BATTERY_REPLACEMENT_YEAR);
    expect(npv20(base) - withBatt).toBeCloseTo(cost, 6);
  });

  it('a zero-capacity battery costs nothing', () => {
    expect(npv20({ ...base, batteryKwh: 0 })).toBeCloseTo(npv20(base), 10);
  });

  it('scales linearly in annual benefit for a fixed cost', () => {
    const a = npv20({ ...base, annualBenefit: 500, sysCostNet: 0 });
    const b = npv20({ ...base, annualBenefit: 1000, sysCostNet: 0 });
    expect(b).toBeCloseTo(a * 2, 6);
  });
});

describe('npvSchedule', () => {
  it('runs the full horizon', () => {
    expect(npvSchedule(base)).toHaveLength(HORIZON_YEARS);
  });

  it('final cumulative equals npv20', () => {
    for (const batteryKwh of [0, 5, 13.5]) {
      const rows = npvSchedule({ ...base, batteryKwh });
      expect(rows[rows.length - 1]!.cumulative).toBeCloseTo(npv20({ ...base, batteryKwh }), 6);
    }
  });

  it('benefit decays year on year', () => {
    const rows = npvSchedule(base);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.undiscounted).toBeLessThan(rows[i - 1]!.undiscounted);
    }
  });

  it('books the battery cost only in the replacement year', () => {
    const rows = npvSchedule({ ...base, batteryKwh: 10 });
    for (const row of rows) {
      if (row.year === BATTERY_REPLACEMENT_YEAR) expect(row.batteryCost).toBeLessThan(0);
      else expect(row.batteryCost).toBe(0);
    }
  });

  it('cumulative starts below zero and rises monotonically outside that year', () => {
    const rows = npvSchedule(base);
    expect(rows[0]!.cumulative).toBeLessThan(0);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.cumulative).toBeGreaterThan(rows[i - 1]!.cumulative);
    }
  });
});

describe('breakevenYear', () => {
  it('finds the first non-negative year', () => {
    const year = breakevenYear(base);
    expect(year).not.toBeNull();
    const rows = npvSchedule(base);
    expect(rows[year! - 1]!.cumulative).toBeGreaterThanOrEqual(0);
    expect(rows[year! - 2]!.cumulative).toBeLessThan(0);
  });

  it('returns null when the system never pays back inside the horizon', () => {
    expect(breakevenYear({ annualBenefit: 50, sysCostNet: 20000, batteryKwh: 0 })).toBeNull();
  });

  it('a cheaper system breaks even no later than a dearer one', () => {
    const cheap = breakevenYear({ ...base, sysCostNet: 5000 })!;
    const dear = breakevenYear({ ...base, sysCostNet: 12000 })!;
    expect(cheap).toBeLessThanOrEqual(dear);
  });
});

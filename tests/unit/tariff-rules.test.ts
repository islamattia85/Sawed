import { describe, it, expect } from 'vitest';
import {
  isInWindow, bandAt, rateAt, isFlatPlan, simulateBaseline, annualCost, sumF, WHOLESALE_CAP,
} from '../../src/engine/tariff-rules.js';
import { HOURS_IN_YEAR, type Tariff } from '../../src/engine/constants.js';

const flat: Tariff = {
  id: 'FLAT', supplier: 'Test', plan: '24h', type: 'flat', standing: 250,
  rates: { day: 0.35 }, windows: {},
};

const dayNight: Tariff = {
  id: 'DN', supplier: 'Test', plan: 'Day/Night', type: 'tou', standing: 300,
  rates: { day: 0.38, night: 0.18 }, windows: { night: [23, 8] },
};

const evPlan: Tariff = {
  id: 'EV', supplier: 'Test', plan: 'EV', type: 'ev', standing: 320,
  rates: { day: 0.40, night: 0.20, peak: 0.50, ev: 0.08 },
  windows: { night: [23, 8], peak: [17, 19], ev: [2, 5] },
};

describe('isInWindow', () => {
  it('is start-inclusive and end-exclusive', () => {
    expect(isInWindow(9, [9, 17])).toBe(true);
    expect(isInWindow(16, [9, 17])).toBe(true);
    expect(isInWindow(17, [9, 17])).toBe(false);
    expect(isInWindow(8, [9, 17])).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    for (const h of [23, 0, 3, 7]) expect(isInWindow(h, [23, 8])).toBe(true);
    for (const h of [8, 12, 22]) expect(isInWindow(h, [23, 8])).toBe(false);
  });

  it('is false when no window is defined', () => {
    expect(isInWindow(12, undefined)).toBe(false);
  });
});

describe('bandAt', () => {
  it('falls back to day when nothing matches', () => {
    for (let h = 0; h < 24; h += 1) expect(bandAt(h, flat)).toBe('day');
  });

  it('resolves the night window including the midnight wrap', () => {
    expect(bandAt(23, dayNight)).toBe('night');
    expect(bandAt(3, dayNight)).toBe('night');
    expect(bandAt(12, dayNight)).toBe('day');
  });

  it('prefers the more specific window when they overlap', () => {
    // 02:00-05:00 is inside both the EV window and the night window.
    expect(bandAt(3, evPlan)).toBe('ev');
    // 17:00-19:00 is peak, and outside night.
    expect(bandAt(18, evPlan)).toBe('peak');
    expect(bandAt(1, evPlan)).toBe('night');
  });

  it('covers all 24 hours with some band', () => {
    for (let h = 0; h < 24; h += 1) expect(bandAt(h, evPlan)).toBeTruthy();
  });
});

describe('isFlatPlan', () => {
  it('detects a single-rate plan', () => {
    expect(isFlatPlan(flat)).toBe(true);
  });

  it('detects a genuine day/night spread', () => {
    expect(isFlatPlan(dayNight)).toBe(false);
  });

  it('treats a sub-0.1c spread as flat in practice', () => {
    const nearlyFlat = { ...flat, rates: { day: 0.3500, night: 0.35005 } };
    expect(isFlatPlan(nearlyFlat)).toBe(true);
  });
});

describe('rateAt', () => {
  it('returns the band rate for a static plan', () => {
    expect(rateAt(12, dayNight)).toBeCloseTo(0.38, 6);
    expect(rateAt(3, dayNight)).toBeCloseTo(0.18, 6);
  });

  it('ignores the wholesale series for a static plan', () => {
    const w = new Float32Array(HOURS_IN_YEAR).fill(5);
    expect(rateAt(12, dayNight, 100, w)).toBeCloseTo(0.38, 6);
  });

  it('adds the wholesale component for a dynamic plan', () => {
    const dyn: Tariff = { ...flat, id: 'DYN', type: 'dynamic', rates: { day: 0.10 }, windows: {} };
    const w = new Float32Array(HOURS_IN_YEAR).fill(0.05);
    expect(rateAt(12, dyn, 42, w)).toBeCloseTo(0.15, 6);
  });

  it('caps a dynamic price spike', () => {
    const dyn: Tariff = { ...flat, id: 'DYN', type: 'dynamic', rates: { day: 0.10 }, windows: {} };
    const w = new Float32Array(HOURS_IN_YEAR).fill(99);
    expect(rateAt(12, dyn, 42, w)).toBeCloseTo(WHOLESALE_CAP + 0.10, 6);
  });

  it('passes a negative wholesale price through, so the user is paid to consume', () => {
    const dyn: Tariff = { ...flat, id: 'DYN', type: 'dynamic', rates: { day: 0.10 }, windows: {} };
    const w = new Float32Array(HOURS_IN_YEAR).fill(-0.15);
    expect(rateAt(12, dyn, 42, w)).toBeCloseTo(-0.05, 6);
  });
});

describe('simulateBaseline', () => {
  const cons = new Float32Array(HOURS_IN_YEAR).fill(0.5);

  it('imports the whole load from the grid', () => {
    expect(sumF(simulateBaseline(flat, cons).grid_import)).toBeCloseTo(0.5 * HOURS_IN_YEAR, 3);
  });

  it('costs a flat plan at exactly rate x consumption', () => {
    expect(sumF(simulateBaseline(flat, cons).cost))
      .toBeCloseTo(0.5 * HOURS_IN_YEAR * 0.35, 2);
  });

  it('a day/night plan is cheaper than flat for the same load when night is cheap', () => {
    expect(sumF(simulateBaseline(dayNight, cons).cost))
      .toBeLessThan(sumF(simulateBaseline(flat, cons).cost));
  });

  it('assigns 9 night hours a day under a 23-08 window', () => {
    const bands = simulateBaseline(dayNight, cons).band;
    const firstDay = bands.slice(0, 24).filter((b) => b === 'night').length;
    expect(firstDay).toBe(9);
  });
});

describe('annualCost', () => {
  const sim = {
    cost: new Float32Array([100, 200, 300]),
    revenue: new Float32Array([25, 25]),
  };

  it('nets import cost plus standing minus export revenue', () => {
    const c = annualCost(sim, flat);
    expect(c.energy_cost).toBeCloseTo(600, 6);
    expect(c.standing).toBe(250);
    expect(c.export_revenue).toBeCloseTo(50, 6);
    expect(c.net).toBeCloseTo(600 + 250 - 50, 6);
  });

  it('handles a plan with no export at all', () => {
    const c = annualCost({ cost: sim.cost, revenue: null }, flat);
    expect(c.export_revenue).toBe(0);
    expect(c.net).toBeCloseTo(850, 6);
  });

  it('can go negative when export revenue exceeds cost plus standing', () => {
    const c = annualCost(
      { cost: new Float32Array([10]), revenue: new Float32Array([500]) }, flat,
    );
    expect(c.net).toBeLessThan(0);
  });
});

import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain JS module, no types
import { savingsLadder, rateStrip, scoreRing, monthBars, dayFlow } from '../../src/ui/charts.js';

/**
 * The V7 objects carry the answer itself, not just its working — the ladder is
 * the first thing on the home screen. So the proportion test matters more
 * here than anywhere: a bar that is the wrong length is a wrong answer.
 */

const widths = (svg: string) =>
  [...svg.matchAll(/<rect x="0" y="[\d.]+" width="([\d.]+)" height="22" rx="11" fill="var\(--(?!track)/g)]
    .map((m) => parseFloat(m[1]!));

describe('savingsLadder', () => {
  const svg = savingsLadder({
    width: 400,
    rungs: [
      { label: 'Today', value: 2000, token: '--ink-dim' },
      { label: 'Switch plan', value: 1500, token: '--accent' },
      { label: 'With solar', value: 500, token: '--accent' },
    ],
  });

  it('draws each rung in proportion to the largest', () => {
    expect(widths(svg)).toEqual([400, 300, 100]);
  });

  it('keeps the exact euro figure on every rung', () => {
    expect(svg).toContain('data-value="2000"');
    expect(svg).toContain('€1,500');
    expect(svg).toContain('<title>With solar: €500/yr</title>');
  });

  it('never draws a negative bill as a negative bar', () => {
    const neg = savingsLadder({ width: 400, rungs: [
      { label: 'Today', value: 1000, token: '--ink-dim' },
      { label: 'Net earner', value: -200, token: '--accent' },
    ] });
    // The figure stays honest (−€200); the bar floors at a sliver, not a negative width.
    expect(neg).toContain('data-value="-200"');
    expect(widths(neg)[1]).toBeGreaterThan(0);
  });

  it('renders nothing rather than an empty frame', () => {
    expect(savingsLadder({ rungs: [] })).toBe('');
  });
});

describe('rateStrip', () => {
  const bands = [...Array(8).fill('night'), ...Array(9).fill('day'), 'peak', 'peak', ...Array(4).fill('day'), 'night'];
  const svg = rateStrip({ bands, rates: { night: 0.17, day: 0.32, peak: 0.4 } });

  it('paints one cell per hour, in its band', () => {
    expect((svg.match(/data-hour=/g) || []).length).toBe(24);
    expect(svg).toContain('data-hour="17" data-band="peak"');
  });

  it('names the rate for each hour', () => {
    expect(svg).toContain('17:00 · peak · 40c/kWh');
  });
});

describe('scoreRing', () => {
  it('fills the ring in proportion to the score', () => {
    const svg = scoreRing({ value: 50, size: 100 });
    const r = 100 / 2 - 6;
    const c = 2 * Math.PI * r;
    const dash = parseFloat(svg.match(/stroke-dasharray="([\d.]+)/)![1]!);
    expect(dash).toBeCloseTo(c / 2, 1);
  });

  it('clamps out-of-range scores', () => {
    expect(scoreRing({ value: 140 })).toContain('data-value="100"');
    expect(scoreRing({ value: -5 })).toContain('data-value="0"');
  });
});

describe('monthBars', () => {
  it('draws twelve months with both series', () => {
    const a = [1, 2, 3, 4, 5, 6, 6, 5, 4, 3, 2, 1].map((v) => v * 100);
    const b = Array(12).fill(400);
    const svg = monthBars({ a, b });
    expect((svg.match(/data-month=/g) || []).length).toBe(12);
    expect(svg).toContain('data-a="600" data-b="400"');
  });
});

describe('the V7 objects follow the same rules as the V6 ones', () => {
  const all = [
    savingsLadder({ rungs: [{ label: 'x', value: 1, token: '--accent' }] }),
    rateStrip({ bands: ['day'] }),
    scoreRing({ value: 40 }),
    monthBars({ a: [1], b: [1] }),
  ].join('');
  it('uses tokens, never hex literals', () => {
    expect(all.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
  it('keeps SVG text at or above the tick floor', () => {
    const sizes = [...all.matchAll(/font-size="([\d.]+)"/g)].map((m) => parseFloat(m[1]!));
    expect(sizes.every((s) => s >= 10)).toBe(true);
  });
});


describe('dayFlow', () => {
  const hour = (o) => ({ solar: 0, batt: 0, grid: 0, ev: 0, charge: 0, exp: 0, band: 'day', ...o });
  const hours = Array.from({ length: 24 }, (_, h) => hour(h === 3
    ? { grid: 3, ev: 2, charge: 1, band: 'ev' }          // cheap window: grid in, EV + battery out
    : h === 18 ? { batt: 1, band: 'peak' } : {}));
  const svg = dayFlow({ hours, height: 114 });
  const rects = (hr) => [...svg.split(`data-hour="${hr}"`)[1].split('</g>')[0]
    .matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => parseFloat(m[1]!));

  it('draws a kWh the same height above and below the line', () => {
    // hour 3: 3 kWh in (one grid bar) and 3 kWh out (EV 2 + battery 1)
    const [grid, ev, charge] = rects(3);
    expect(grid).toBeCloseTo(ev! + charge!, 2);
    expect(ev).toBeCloseTo(2 * charge!, 2);
  });

  it('keeps every flow on the hour for the reader who taps it', () => {
    expect(svg).toContain('data-hour="3" data-solar="0" data-batt="0"');
    expect(svg).toContain('data-grid="3" data-ev="2" data-charge="1" data-exp="0"');
  });

  it('uses tokens only and keeps its ticks readable', () => {
    expect(svg.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect([...svg.matchAll(/font-size="([\d.]+)"/g)].every((m) => parseFloat(m[1]!) >= 10)).toBe(true);
  });
});

describe('dayFlow — house line and capped outliers', () => {
  const hour = (o) => ({ solar: 0, batt: 0, grid: 0, ev: 0, charge: 0, exp: 0, band: 'day', ...o });
  // an ordinary day of ~1 kWh an hour, and one 2am hour where the battery
  // takes 6 kWh from the grid on top of the house's 0.5
  const hours = Array.from({ length: 24 }, (_, h) =>
    h === 2 ? hour({ grid: 6.5, charge: 6, band: 'ev' }) : hour({ grid: 1 }));
  const svg = dayFlow({ hours, height: 120 });

  it('draws the house use as a line, from in minus out', () => {
    expect(svg).toContain('class="v7-house-line"');
    expect(svg).toContain('data-hour="2"');
    expect(svg).toMatch(/data-hour="2"[^>]*data-house="0.5"/);
    expect(svg).toMatch(/data-hour="5"[^>]*data-house="1"/);
  });

  it('cuts an outlier at the cap, marks it, and prints its real figure', () => {
    expect(svg).toContain('data-capped="6.5"');
    expect(svg).toContain('data-capped="6"');
    expect(svg).toMatch(/>6\.5<\/text>/);
    expect(svg).toMatch(/>6<\/text>/);
  });

  it('leaves an ordinary day uncapped', () => {
    const even = dayFlow({ hours: Array.from({ length: 24 }, () => hour({ grid: 1, exp: 0.5 })) });
    expect(even).not.toContain('data-capped');
  });
});

describe('dayFlow — a run of EV-charging hours does not set its own cap', () => {
  const hour = (o) => ({ solar: 0, batt: 0, grid: 0, ev: 0, charge: 0, exp: 0, band: 'day', ...o });
  // four hours of 7 kWh overnight charging, against a day of ~0.6 kWh hours
  const hours = Array.from({ length: 24 }, (_, h) => (h >= 2 && h < 6
    ? hour({ grid: 7.5, ev: 7, band: 'ev' }) : hour({ grid: 0.6 })));
  it('caps all four charging hours, so the ordinary day stays readable', () => {
    const svg = dayFlow({ hours });
    expect((svg.match(/data-capped="7.5"/g) || []).length).toBe(4);
    // …and the four share one label, not four colliding ones.
    expect((svg.match(/data-run="2-5"/g) || []).length).toBe(2);   // one above, one below
    expect(svg).toMatch(/>up to 7\.5<\/text>/);
  });
});

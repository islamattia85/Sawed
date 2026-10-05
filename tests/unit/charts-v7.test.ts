import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain JS module, no types
import { savingsLadder, rateStrip, scoreRing, monthBars } from '../../src/ui/charts.js';

/**
 * The V7 objects carry the answer itself, not just its working — the ladder is
 * the first thing on the home screen. So the proportion test matters more
 * here than anywhere: a bar that is the wrong length is a wrong answer.
 */

// The ladder is plain rows now (full plan names wrap); each bar is a % of the largest.
const widths = (html: string) =>
  [...html.matchAll(/<i style="width:([\d.]+)%;background:var\(--/g)].map((m) => parseFloat(m[1]!));

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
    expect(widths(svg)).toEqual([100, 75, 25]);
  });

  it('keeps the exact euro figure on every rung', () => {
    expect(svg).toContain('data-value="2000"');
    expect(svg).toContain('€1,500');
    expect(svg).toContain('title="With solar: €500/yr"');
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



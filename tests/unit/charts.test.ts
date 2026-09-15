import { describe, it, expect } from 'vitest';
// @ts-expect-error - plain JS module, no types
import { moneyBar, dayProfile, yearRibbon, paybackCurve, bandDonut, eur } from '../../src/ui/charts.js';

/**
 * The V6 objects replace prose with shapes, which is only an improvement if the
 * shape is faithful and the figure is still reachable. These tests hold both:
 * the geometry must be proportional to the data, and every object must still
 * carry its exact numbers for the reader who taps it.
 */

const TICK_MIN = 10;
const svgFontSizes = (svg: string) =>
  [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => parseFloat(m[1]!));
const hexLiterals = (svg: string) => [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);

const ALL = [
  moneyBar({ segments: [
    { label: 'Day', value: 600, token: '--band-day' },
    { label: 'Night', value: 200, token: '--band-night' },
    { label: 'Standing', value: 250, token: '--ink-dim' },
  ] }),
  dayProfile({ hours: Array.from({ length: 24 }, (_, h) => ({
    cons: 0.4 + (h > 16 && h < 21 ? 0.8 : 0), gen: h > 8 && h < 17 ? 0.9 : 0,
    imp: 0.3, band: h >= 17 && h < 19 ? 'peak' : h >= 23 || h < 8 ? 'night' : 'day',
  })) }),
  yearRibbon({ days: Array.from({ length: 365 }, (_, i) => 2 + Math.sin(i / 58) * 1.5) }),
  paybackCurve({ cumulative: [-12000, -10600, -9200, -7800, -6400, -5000, -3600, -2200, -800, 600, 2000] }),
  bandDonut({ slices: [
    { label: 'Day', value: 3000, token: '--band-day' },
    { label: 'Night', value: 1500, token: '--band-night' },
  ] }),
].join('\n');

describe('the V6 data objects obey the design system', () => {
  it('draw no text below the SVG tick floor', () => {
    const tooSmall = svgFontSizes(ALL).filter((v) => v < TICK_MIN);
    expect(tooSmall, `SVG text below ${TICK_MIN}px: ${tooSmall.join(', ')}`).toEqual([]);
  });

  it('take every colour from a token, never a hex literal', () => {
    expect(hexLiterals(ALL)).toEqual([]);
  });

  it('are pure — the same data draws the same markup', () => {
    const args = { segments: [{ label: 'Day', value: 600, token: '--band-day' }] };
    expect(moneyBar(args)).toBe(moneyBar(args));
  });
});

describe('moneyBar', () => {
  it('gives each segment a width in proportion to its share', () => {
    const svg = moneyBar({ segments: [
      { label: 'A', value: 750, token: '--band-day' },
      { label: 'B', value: 250, token: '--band-night' },
    ], width: 400 });
    const widths = [...svg.matchAll(/<rect[^>]*width="([\d.]+)"[^>]*fill="var\(--band/g)]
      .map((m) => parseFloat(m[1]!));
    expect(widths[0]).toBeCloseTo(300, 1);   // 75% of 400
    expect(widths[1]).toBeCloseTo(100, 1);   // 25% of 400
  });

  it('keeps the exact euro figure reachable on every segment', () => {
    const svg = moneyBar({ segments: [{ label: 'Standing charge', value: 250.77, token: '--ink-dim' }] });
    expect(svg).toContain('data-value="250.77"');
    expect(svg).toContain('Standing charge: €251');
  });

  it('draws nothing rather than a misleading empty bar', () => {
    expect(moneyBar({ segments: [] })).toBe('');
    expect(moneyBar({ segments: [{ label: 'x', value: 0, token: '--ink' }] })).toBe('');
  });
});

describe('dayProfile', () => {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    cons: h === 18 ? 2 : 0.5, gen: h === 12 ? 1 : 0, imp: 0.2,
    band: h === 18 ? 'peak' : 'day',
  }));

  it('scales the tallest bar to the plot and the rest against it', () => {
    const svg = dayProfile({ hours, height: 132 });
    // the 18:00 spike is 4x the 0.5 kWh baseline, so its bar must be ~4x taller
    const m = [...svg.matchAll(/data-hour="(\d+)"[^]*?height="([\d.]+)"/g)];
    const byHour = new Map(m.map((x) => [Number(x[1]), parseFloat(x[2]!)]));
    expect(byHour.get(18)! / byHour.get(0)!).toBeCloseTo(4, 0);
  });

  it('paints the tariff band behind the hour it belongs to', () => {
    const svg = dayProfile({ hours });
    expect(svg).toContain('var(--band-peak)');
    expect(svg).toContain('data-band="peak"');
  });

  it('carries the hour\'s real figures for tapping', () => {
    const svg = dayProfile({ hours });
    expect(svg).toContain('data-cons="2"');
    expect(svg).toMatch(/18:00 · used 2 kWh/);
  });
});

describe('yearRibbon', () => {
  it('draws one cell per day', () => {
    const svg = yearRibbon({ days: Array.from({ length: 365 }, () => 1) });
    expect([...svg.matchAll(/<rect/g)].length).toBe(365);
  });

  it('darkens the dearer day', () => {
    const svg = yearRibbon({ days: [1, 10] });
    const ops = [...svg.matchAll(/opacity="([\d.]+)"/g)].map((m) => parseFloat(m[1]!));
    expect(ops[1]).toBeGreaterThan(ops[0]!);
  });
});

describe('paybackCurve', () => {
  it('marks the year the running total first turns positive', () => {
    const svg = paybackCurve({ cumulative: [-100, -60, -20, 30, 80] });
    expect(svg).toContain('data-payback-year="3"');
    expect(svg).toContain('Pays for itself in year 3');
  });

  it('marks no payback when it never pays back', () => {
    const svg = paybackCurve({ cumulative: [-100, -90, -80, -70] });
    expect(svg).not.toContain('data-payback-year');
  });
});

describe('bandDonut', () => {
  it('turns each slice into its share of the circle', () => {
    const svg = bandDonut({ slices: [
      { label: 'Day', value: 75, token: '--band-day' },
      { label: 'Night', value: 25, token: '--band-night' },
    ] });
    expect(svg).toContain('Day: 75%');
    expect(svg).toContain('Night: 25%');
  });
});

describe('eur', () => {
  it('speaks in whole euro, the way the app does', () => {
    expect(eur(1234.6)).toBe('€1,235');
    expect(eur(0)).toBe('€0');
  });
});

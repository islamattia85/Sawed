import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A design system only holds if violating it fails something.
 *
 * Before this, the app carried 31 distinct font sizes, 21 border radii and 121
 * padding combinations across 636 declarations, with 859 inline `style=`
 * attributes against 369 CSS classes. With no scale to violate, 9.5px was as
 * defensible as anything else — which is how half the interface ended up set
 * below 12px on a product read by homeowners deciding on a four-figure switch.
 *
 * These tests fix the scale in place. Adding a step is a deliberate act that
 * edits this file; drifting into one is not possible.
 */

const root = dirname(fileURLToPath(import.meta.url));
const JS = readFileSync(join(root, '../../src/main.js'), 'utf8');
const CSS = readFileSync(join(root, '../../src/styles/main.css'), 'utf8');
const ALL = `${JS}\n${CSS}`;

/** The type scale, in px. Everything the interface renders must be one of these. */
const TYPE_SCALE = [12, 13, 15, 17, 20, 25, 32, 40, 54];
/** Corner radii. 999 is the pill. */
const RADIUS_SCALE = [4, 8, 12, 16, 999];
/** Chart annotation inside SVG — a different role, with its own lower floor. */
const TICK_MIN = 10;

const numbers = (src: string, prop: string) =>
  [...src.matchAll(new RegExp(`${prop}:\\s*([\\d.]+)px`, 'g'))].map((m) => parseFloat(m[1]!));

describe('type scale', () => {
  it('every font-size is a step on the scale', () => {
    const offScale = [...new Set(numbers(ALL, 'font-size'))]
      .filter((v) => !TYPE_SCALE.includes(v))
      .sort((a, b) => a - b);
    expect(offScale,
      `these font sizes are not on the scale [${TYPE_SCALE.join(', ')}]: ${offScale.join(', ')}`)
      .toEqual([]);
  });

  it('nothing in the interface is set below 12px', () => {
    const tooSmall = [...new Set(numbers(ALL, 'font-size'))].filter((v) => v < 12);
    expect(tooSmall, `below the 12px floor: ${tooSmall.join(', ')}`).toEqual([]);
  });

  it('chart annotation drawn in SVG stays above its own floor', () => {
    const ticks = [...ALL.matchAll(/font-size="([\d.]+)"/g)].map((m) => parseFloat(m[1]!));
    const tooSmall = [...new Set(ticks)].filter((v) => v < TICK_MIN).sort((a, b) => a - b);
    expect(tooSmall, `SVG text below ${TICK_MIN}px: ${tooSmall.join(', ')}`).toEqual([]);
  });

  it('keeps the scale small enough to be a scale', () => {
    expect(new Set(numbers(ALL, 'font-size')).size).toBeLessThanOrEqual(TYPE_SCALE.length);
  });
});

describe('radius scale', () => {
  it('every border-radius is a step on the scale', () => {
    const offScale = [...new Set(numbers(ALL, 'border-radius'))]
      .filter((v) => !RADIUS_SCALE.includes(v))
      .sort((a, b) => a - b);
    expect(offScale,
      `these radii are not on the scale [${RADIUS_SCALE.join(', ')}]: ${offScale.join(', ')}`)
      .toEqual([]);
  });
});

describe('tokens', () => {
  it('the scales are declared, not merely obeyed', () => {
    for (const token of ['--text-caption', '--text-body', '--text-h1', '--text-hero',
      '--space-1', '--space-4', '--radius-md', '--radius-pill', '--text-tick']) {
      expect(CSS.includes(`${token}:`), `${token} is not defined`).toBe(true);
    }
  });

  it('colour still runs through tokens rather than raw literals', () => {
    const raw = new Set([...JS.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]));
    const tokens = [...JS.matchAll(/var\(--[\w-]+\)/g)].length;
    // Colour was already disciplined; this guards against regression, not perfection.
    expect(tokens).toBeGreaterThan(800);
    expect(raw.size, `raw hex values in markup: ${[...raw].join(' ')}`).toBeLessThan(45);
  });
});

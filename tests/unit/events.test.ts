import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EVENT_NAMES } from '../../api/event.js';

/**
 * The usage counts (29 Oct 2026). The app names each step it counts; the
 * server keeps only the names on its list and refuses the rest, so a name
 * the list lacks is a step that is never counted, silently.
 */
const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
/** Each call to trackEvent: the step's name, and the whole call, read to its closing bracket. */
const calls = [...main.matchAll(/trackEvent\('([a-z_]+)'/g)].map((m) => {
  let depth = 0, i = m.index! + 'trackEvent'.length;
  for (; i < main.length; i++) { if (main[i] === '(') depth++; else if (main[i] === ')' && --depth === 0) break; }
  return { name: m[1]!, props: main.slice(m.index!, i) };
});

describe('usage counts', () => {
  it('finds the steps the app counts', () => {
    expect(new Set(calls.map((c) => c.name))).toEqual(new Set([
      'screen_viewed', 'setup_started', 'setup_finished', 'meter_file_added', 'report_downloaded', 'result_shared',
      'switch_click', 'lead_submitted',
    ]));
  });

  it('every step the app sends is one the server keeps', () => {
    expect(calls.map((c) => c.name).filter((n) => !EVENT_NAMES.includes(n))).toEqual([]);
  });

  /**
   * What a step carries is a yes or no, a screen, a route: never an amount,
   * a place or anything typed. The switch click and a quote request carry
   * their own, older fields (the plan, its saving, a county), each on its
   * own consent.
   */
  it('the steps carry nothing about the home or the person', () => {
    const keys = calls.filter((c) => !['switch_click', 'lead_submitted'].includes(c.name))
      .flatMap((c) => [...c.props.matchAll(/([a-z_]+)\s*:/g)].map((m) => `${c.name}.${m[1]}`));
    const allowed = /\.(screen|route|solar|ev|meter_file|how|details)$/;
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((k) => !allowed.test(k))).toEqual([]);
  });
});

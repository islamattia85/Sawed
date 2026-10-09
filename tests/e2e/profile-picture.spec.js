import { test, expect } from '@playwright/test';
import { runScenario, SCENARIOS } from './run-scenario.js';

/**
 * Profile's picture of the home and the line under it say the same year.
 * The picture showed "Home uses 5,943 kWh" over "5,344 kWh a year" for a home
 * whose meter file ran past a year; and for a home with its panels up and a
 * file that records what they sell, "Solar makes 0 kWh" and, as the home's
 * use, what it bought.
 */
const read = (page) => page.evaluate(() => {
  window.setScreen('profile');
  const t = (document.querySelector('.hs') || {}).textContent || '';
  const n = (re) => { const m = t.match(re); return m ? +m[1].replace(/,/g, '') : null; };
  const row = (document.querySelector('.pf-row small') || {}).textContent || '';
  return { use: n(/Home uses ([\d,]+)/), solar: n(/Solar makes ([\d,]+)/), sold: n(/↑ ([\d,]+)/), bought: n(/↓ ([\d,]+)/),
    year: +((row.match(/([\d,]+) kWh a year/) || [0, '0'])[1].replace(/,/g, '')) };
});

test('a meter file of two years: the picture and the line under it give the same yearly use', async ({ page }) => {
  test.setTimeout(120000);
  await runScenario(page, SCENARIOS.find((s) => s.id === 'A7-heatpump'));
  const r = await read(page);
  expect(r.year).toBeGreaterThan(1000);
  expect(Math.abs(r.use - r.year), JSON.stringify(r)).toBeLessThanOrEqual(r.year * 0.005);
});

test('panels up and a file that records their sales: the picture shows what they make and sell', async ({ page }) => {
  test.setTimeout(120000);
  await runScenario(page, SCENARIOS.find((s) => s.id === 'B2-hp_solar_batt'));
  const r = await read(page);
  expect(r.use, JSON.stringify(r)).toBe(r.year);
  expect(r.sold).toBeGreaterThan(0);
  expect(r.solar).toBeGreaterThan(r.sold);
  // What the panels made is what the home used, less what it bought, plus what it sold.
  expect(Math.abs(r.solar - (r.use - r.bought + r.sold))).toBeLessThanOrEqual(1);
});

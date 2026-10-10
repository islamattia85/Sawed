import { test, expect } from '@playwright/test';
import { runScenario, SCENARIOS } from './run-scenario.js';
import { boot } from './support.js';

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

test('a meter file of two years whose use grew: the upload card gives the year Profile does, and names the year before', async ({ page }) => {
  test.setTimeout(120000);
  // Made up: 0.25 kWh a half hour from 1 June 2024, 25% more from 1 June 2025, to 31 May 2026.
  // The card had averaged both years (5,344 kWh for one home) while Profile showed the latest (5,943).
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  const pad = (n) => String(n).padStart(2, '0');
  for (let t = Date.UTC(2024, 5, 1, 0, 30); t <= Date.UTC(2026, 5, 1, 0, 0); t += 1800000) {
    const d = new Date(t), start = new Date(t - 1800000);
    rows.push(`1,2,${start >= new Date(Date.UTC(2025, 5, 1)) ? 0.3125 : 0.25},Active Import Interval (kWh),${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`);
  }
  await boot(page, { current_screen: 'updates' });
  await page.evaluate(() => window.v7Sheet('meter'));
  await page.locator('#csv-file-input').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await page.waitForFunction(() => /Total:/.test(document.querySelector('#csv-parse-result')?.innerText || ''));
  const card = await page.locator('#csv-parse-result').innerText();
  const num = (re) => +((card.match(re) || [0, '0'])[1].replace(/,/g, ''));
  const total = num(/Total: ([\d,]+) kWh/), before = num(/12 months before came to ([\d,]+) kWh/);
  expect(Math.abs(total - 365 * 48 * 0.3125), card).toBeLessThanOrEqual(30);
  expect(Math.abs(before - 365 * 48 * 0.25), card).toBeLessThanOrEqual(30);
  expect(card).toContain('Your file runs 1 Jun 2024 to 31 May 2026.');
  await page.locator('#csv-parse-result [data-filehome="yes"]').click();
  const r = await read(page);
  expect(r.use, JSON.stringify(r)).toBe(total);
  expect(r.year, JSON.stringify(r)).toBe(total);
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

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
  return { use: n(/([\d,]+) kWh used/), solar: n(/([\d,]+) kWh made/), sold: n(/([\d,]+) kWh sold/), bought: n(/([\d,]+) kWh bought/),
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

test('the picture: its words keep clear of each other and of what they describe, even with long figures, and each part opens its place', async ({ page }) => {
  test.setTimeout(120000);
  // Made up: a big home, panels on two roofs, a battery, a long-distance car and a heat pump.
  const errors = await boot(page, { has_solar: true, solar_planned: false, considering_solar: true, count_A: 12, count_B: 8, panel_w: 460, azimuth_A: 180, tilt_A: 35,
    azimuth_B: 90, tilt_B: 35, battery_kwh: 13.5, heating_type: 'heatpump', region: 'south', baseline: 'EN-EV', baseline_known: true, bimonthly_bill_eur: 700,
    usage_input_mode: 'bill', bill_when: 'before', ev_active: true, ev_km_per_year: 40000, hot_water_strategy: 'legacy', current_screen: 'profile' });
  await page.evaluate(() => window.setScreen('profile'));
  const r = await page.evaluate(() => {
    const box = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
    const meet = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
    const words = [...document.querySelectorAll('.hs-label tspan')].map((e) => ({ text: e.textContent, ...box(e) }));
    const names = [...document.querySelectorAll('.hs-hit')].map((e) => e.getAttribute('aria-label'));
    const card = box(document.querySelector('.hs'));
    const clash = [];
    words.forEach((w, i) => {
      words.slice(i + 1).forEach((v) => { if (meet(w, v)) clash.push(`${w.text} / ${v.text}`); });
      // Against the parts' own shapes (the roof is not a box): any point of the line on one of them.
      const on = new Set();
      for (let x = w.l + 1; x < w.r - 1; x += 3) for (let y = w.t + 1; y < w.b - 1; y += 3)
        document.elementsFromPoint(x, y).forEach((e) => { if (e.classList.contains('hs-hit')) on.add(e.getAttribute('aria-label')); });
      on.forEach((name) => clash.push(`${w.text} / ${name}`));
      if (w.l < card.l || w.r > card.r) clash.push(`${w.text} / the card's edge`);
    });
    return { n: words.length, names, clash };
  });
  expect(r.n, 'five labels of three lines').toBe(15);
  expect(r.clash).toEqual([]);
  expect(r.names).toEqual(['My home', 'My system', 'Heat pump', 'Your plan and the grid', 'Battery', 'Your EV']);
  await page.locator('.hs-hit[aria-label="Your plan and the grid"]').click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('plans');
  expect(errors).toEqual([]);
});

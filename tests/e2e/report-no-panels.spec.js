import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot } from './support.js';

/**
 * The report for a home without panels, and the figures it shares with the
 * app (30 Oct 2026). The user test found two solar pages in it ("a swing of
 * about 0.0:1", "0 kWh for every kWp", four days of what the panels made),
 * fixed charges of €270 beside the app's €257 (an old PSO levy of €19.10),
 * and 35, 33 and "all 33" plans in one report.
 */
test.describe('a home without panels', () => {
  // The service worker would serve the report's typeface past the block below.
  test.use({ serviceWorkers: 'block' });

  test('its report has its use by month, the app\'s fixed charges and one plan count, and no solar pages', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const errors = await boot(page, { has_solar: false, solar_planned: false, count_A: 0, count_B: 0, battery_kwh: 0 }, '/');
    const app = await page.evaluate(() => {
      window.setScreen('result');
      const rec = window.getRecommendation();
      return { ranked: rec.ranked.length, home: document.querySelector('.web-dash, #app, body').innerText };
    });
    // Home: nothing is exported, so nothing is "taken off".
    expect(app.home).not.toContain('once the export is taken off');
    expect(app.home).toMatch(/a year, all in/);

    // The app's fixed charges, from its Figures page.
    await page.evaluate(() => window.anTab('bill'));
    const fixed = await page.evaluate(() => {
      const row = [...document.querySelectorAll('*')].find((e) => e.children.length < 6 && /^Fixed charges/.test(e.innerText || '') && /€\d/.test(e.innerText || ''));
      // The row reads "Fixed charges / Standing charge €X, PSO levy €Y / €total": the total is the largest.
      const all = row ? [...row.innerText.matchAll(/€([\d,]+)/g)].map((m) => +m[1].replace(/,/g, '')) : [];
      return all.length ? Math.max(...all) : null;
    });
    expect(fixed).toBeGreaterThan(100);

    await page.route('**/assets/fonts-*.js', (r) => r.abort());
    const download = page.waitForEvent('download', { timeout: 45_000 });
    await page.evaluate(() => window.doGeneratePdf(''));
    const path = testInfo.outputPath('report.pdf');
    await (await download).saveAs(path);
    const raw = readFileSync(path).toString('latin1');

    // No solar pages.
    expect(raw).not.toMatch(/swing of about|for every kWp installed|Four days across the year|what the panels produced/);
    expect(raw).toMatch(/uses the most electricity and/);
    expect(raw).toContain('USE AND COST BY MONTH');
    // The fixed charges the app shows.
    const at = raw.indexOf('(Fixed charges)');
    expect(at, 'the report names its fixed charges').toBeGreaterThan(0);
    expect(raw.slice(at, at + 1500)).toContain(`(\x80${fixed.toLocaleString('en-IE')})`);
    // One plan count, and the ranked ones named as such.
    const count = +raw.match(/\((\d+) plans compared\)|PLANS COMPARED\)[\s\S]{0,400}?\((\d+)\)/).slice(1).find(Boolean);
    expect(count).toBeGreaterThanOrEqual(app.ranked);
    expect(raw).toContain(`of the ${app.ranked} ranked plans for your home`);
    if (app.ranked < count) expect(raw).toContain(`The ${app.ranked} ranked plans of the ${count} for your meter`);
    expect(raw).not.toMatch(/All \d+ plans priced against/);
    expect(errors).toEqual([]);
  });
});

import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The heavy jobs run in a background worker, and give the same figures the
 * page would: the systems list is compared against the page's own sums.
 */
const QUOTE = { id: 'qa', installer: 'Alpha Solar', price: 9800, kwp: 4.4, panels: 10, watts: 440, battery: 5, grant: 1800, azimuth: 180, source: 'upload' };

test('the systems list is worked out in a worker, with the page\'s own figures', async ({ page }) => {
  const errors = await boot(page, { has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 9, solar_quotes: [QUOTE], current_screen: 'solar' });
  await page.evaluate(() => window.openMySystem());
  const row = page.locator('.sys-row', { hasText: 'Alpha Solar' });
  await expect(row.locator('.sys-m')).toHaveCount(4, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__simJobs || 0)).toBeGreaterThan(0);
  const shown = await row.locator('.sys-m').nth(1).locator('b').textContent();
  const onPage = await page.evaluate(() => window.withSimState(window.quoteChanges(window.state.solar_quotes[0]), window.quickOutcome).payback.toFixed(1));
  expect(shown).toBe(`${onPage} yrs`);
  // The suggested sizes came from the worker too, and match the page's sizing run.
  await expect(page.locator('.sys-g-suggested .sys-row').first()).toBeVisible({ timeout: 60_000 });
  const [fromWorker, pageSweep] = await page.evaluate(() => {
    const pick = (sw) => JSON.stringify(sw.designs.map((d) => [d.panels, d.batt, d.net, d.benefit, d.payback, d.planId]));
    const w = pick(window.sweepGoalDesigns());
    window.__clearSweep();                          // the page works it out itself, step by step
    while (!window.sweepGoalStep());
    return [w, pick(window.sweepGoalDesigns())];
  });
  expect(fromWorker).toBe(pageSweep);
  expect(errors).toEqual([]);
});

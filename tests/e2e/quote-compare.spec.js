import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Three quotes, three systems: each is run on this home and ranked by payback,
 * so the person compares what each would earn them, not just the prices.
 */
const QUOTES = [
  { id: 'qa', installer: 'Alpha Solar', price: 14500, kwp: 6.16, panels: 14, watts: 440, battery: 10, grant: 1800, azimuth: 180, source: 'upload' },
  { id: 'qb', installer: 'Beta Energy', price: 9800, kwp: 4.4, panels: 10, watts: 440, battery: 5, grant: 1800, azimuth: 180, source: 'upload' },
  { id: 'qc', installer: 'Gamma PV', price: 13200, kwp: 10.34, panels: 22, watts: 470, battery: 9, grant: 1800, source: 'upload',
    faces: [{ panels: 11, azimuth: 225, tilt: 30 }, { panels: 11, azimuth: 135, tilt: 30 }] },
];

test('saved quotes are run on this home, ranked by payback, and one can be made the system with Undo', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'me', solar_quotes: QUOTES });
  const rows = page.locator('.me-quote');
  await expect(rows.first().locator('.me-qout')).toContainText('Pays back', { timeout: 15_000 });
  const years = (await rows.locator('.me-qout').allTextContents()).map((t) => parseFloat((t.match(/in ([\d.]+) yrs/) || [0, 'Infinity'])[1]));
  expect(years).toEqual(years.slice().sort((a, b) => a - b));
  await expect(rows.first()).toHaveClass(/is-best/);
  await expect(page.locator('.me-qbest')).toHaveCount(1);
  // The two-face quote says so.
  await expect(page.locator('.me-quote', { hasText: 'Gamma PV' })).toContainText('11 + 11 panels on two faces');
  // Make it the system: two faces, its price; Undo puts the home back.
  const before = await page.evaluate(() => [window.state.count_A, window.state.count_B, window.state.install_cost]);
  await page.locator('.me-quote', { hasText: 'Gamma PV' }).getByRole('button', { name: 'Make this my system' }).click();
  expect(await page.evaluate(() => [window.state.count_A, window.state.count_B, window.state.azimuth_A, window.state.azimuth_B, window.state.install_cost]))
    .toEqual([11, 11, 225, 135, 13200]);
  await page.locator('.v7-undo button', { hasText: 'Undo' }).click();
  expect(await page.evaluate(() => [window.state.count_A, window.state.count_B, window.state.install_cost])).toEqual(before);
  expect(errors).toEqual([]);
});

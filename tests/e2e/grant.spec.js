import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Not every home gets the SEAI grant: only those built and lived in before
 * 2021 that have not claimed one. It is set once, in My home, and no system,
 * quote or suggestion counts a grant for a home that does not get one.
 */
const QUOTE = { id: 'qa', installer: 'Alpha Solar', price: 9800, kwp: 4.4, panels: 10, watts: 440, battery: 5, grant: 1800, azimuth: 180, source: 'upload' };

test('a home without the grant gets none anywhere: the system, a quote, the suggestions', async ({ page }) => {
  const errors = await boot(page, { has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 5, solar_quotes: [QUOTE], current_screen: 'result' });
  await page.evaluate(() => window.openMyHome());
  const toggle = page.getByRole('switch', { name: 'SEAI grant' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  expect(await page.evaluate(() => [window.state.grant_eligible, window.state.grant_seai])).toEqual([false, 0]);
  // A quote that states a grant is costed without it.
  const q = await page.evaluate(() => window.withSimState(window.quoteChanges(window.state.solar_quotes[0]), () => [window.state.grant_seai, window.quickOutcome().cost]));
  expect(q).toEqual([0, 9800]);
  // Suggested sizes are priced without it.
  const g = await page.evaluate(() => { const sw = window.sweepGoalDesigns(); return sw.designs.every((d) => d.grant === 0 && d.net === d.cost); });
  expect(g).toBe(true);
  // The Solar answer and My system say so.
  await page.evaluate(() => { window.v7Sheet(null); window.anTab('solar'); });
  await expect(page.locator('.ax-eq')).toContainText('no SEAI grant');
  await page.evaluate(() => window.openMySystem());
  await expect(page.locator('#v7-sheet .sy-grant')).toContainText('Not counted');
  await expect(page.locator('#v7-sheet .sys-head')).toContainText('does not get the SEAI grant');
  // Back on: the standard grant returns.
  await page.evaluate(() => window.setGrantEligible(true));
  expect(await page.evaluate(() => window.state.grant_seai)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a home that switched the grant off before is carried over as not eligible', async ({ page }) => {
  await boot(page, { schema_version: 3, has_solar: true, considering_solar: true, count_A: 10, install_cost: 9000, grant_is_manual: true, grant_seai: 0 });
  expect(await page.evaluate(() => window.state.grant_eligible)).toBe(false);
});

test('a home without the grant never shows one, even if a grant figure was stored', async ({ page }) => {
  await boot(page, { has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 9, install_cost: 11800, grant_seai: 1800, grant_eligible: false, current_screen: 'result' });
  await page.evaluate(() => { setScreen('analytics'); anTab('solar'); v7Sheet('life'); });
  await expect(page.locator('#v7-sheet')).not.toContainText('grant');
  await expect(page.locator('#v7-sheet')).toContainText('€11,800');
});

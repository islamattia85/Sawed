import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Systems: one list in My system of every system this home could have,
 * suggested, from quotes and saved, each run on the home with the same four
 * figures. Tapping one makes it the system, with a progress card and Undo.
 */
const QUOTES = [
  { id: 'qa', installer: 'Alpha Solar', price: 14500, kwp: 6.16, panels: 14, watts: 440, battery: 10, grant: 1800, azimuth: 180, source: 'upload' },
  { id: 'qc', installer: 'Gamma PV', price: 13200, kwp: 10.34, panels: 22, watts: 470, battery: 9, grant: 1800, source: 'upload',
    faces: [{ panels: 11, azimuth: 225, tilt: 30 }, { panels: 11, azimuth: 135, tilt: 30 }] },
];
const SAVED = [{ id: 's1', name: 'Two roofs, small battery', cfg: { has_solar: true, count_A: 8, count_B: 8, azimuth_A: 135, azimuth_B: 225, tilt_A: 30, tilt_B: 30, battery_kwh: 5, cost_is_manual: false, grant_is_manual: false } }];

async function open(page, extra = {}) {
  const errors = await boot(page, { current_screen: 'solar', solar_quotes: QUOTES, saved_systems: SAVED, ...extra });
  await page.evaluate(() => window.openMySystem());
  await expect(page.locator('.sys-row .sys-m').first()).toBeVisible({ timeout: 60_000 });
  return errors;
}

test('suggested, quotes and saved in one list, each with cost, payback, 20 years and own power', async ({ page }) => {
  const errors = await open(page);
  const list = page.locator('.sys-list');
  await expect(list.locator('.sys-group.sys-g-suggested .sys-row').first()).toBeVisible({ timeout: 60_000 });
  await expect(list.locator('.sys-g-quotes .sys-row')).toHaveCount(2);
  await expect(list.locator('.sys-g-yours .sys-row', { hasText: 'Two roofs, small battery' })).toContainText('8 SE + 8 SW');
  await expect(list.locator('.sys-g-quotes .sys-row', { hasText: 'Gamma PV' })).toContainText('11 SW + 11 SE');
  // Every row ends with the same four figures; a priceless saved system is priced, never negative.
  for (const row of await list.locator('.sys-row').all()) await expect(row.locator('.sys-m')).toHaveCount(4, { timeout: 60_000 });
  const savedCost = await list.locator('.sys-g-yours .sys-row .sys-m b').first().textContent();
  expect(savedCost).not.toMatch(/-|−/);
  // Prices before the grant: a quote's exactly as quoted, a suggestion's as a rounded guide price.
  await expect(list.locator('.sys-g-quotes .sys-row', { hasText: 'Gamma PV' }).locator('.sys-m').first()).toContainText('€13,200');
  await expect(list.locator('.sys-g-quotes .sys-row', { hasText: 'Gamma PV' }).locator('.sys-m').first()).toContainText('before grant');
  const sug = list.locator('.sys-g-suggested .sys-row').first().locator('.sys-m').first();
  await expect(sug).toContainText(/~€[\d,]+00/);
  await expect(sug).toContainText('guide price');
  // The system in use is marked once.
  await expect(list.locator('.sys-row.in-use')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('tapping a system shows the work, makes it the system, and Undo puts the home back', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => [window.state.count_A, window.state.count_B, window.state.install_cost]);
  await page.locator('.sys-row', { hasText: 'Gamma PV' }).locator('.sys-main').click();
  await expect(page.locator('.sys-busy')).toBeVisible();
  await expect(page.locator('.sys-busy')).toContainText('Simulating your year');
  await expect(page.locator('.sys-busy')).toHaveCount(0, { timeout: 15_000 });
  expect(await page.evaluate(() => [window.state.count_A, window.state.count_B, window.state.azimuth_A, window.state.azimuth_B, window.state.install_cost]))
    .toEqual([11, 11, 225, 135, 13200]);
  await expect(page.locator('.sys-row.in-use')).toContainText('Gamma PV', { timeout: 60_000 });
  await page.locator('#v7-sheet .v7-undo button', { hasText: 'Undo' }).click();
  expect(await page.evaluate(() => [window.state.count_A, window.state.count_B, window.state.install_cost])).toEqual(before);
});

test('the system as it is can be saved under a name, and removed', async ({ page }) => {
  await open(page, { saved_systems: [] });
  await page.getByRole('button', { name: /Save this system under a name/ }).click();
  await page.locator('#sys-name').fill('My first idea');
  await page.locator('.sys-save').getByRole('button', { name: 'Save' }).click();
  const saved = page.locator('.sys-g-yours .sys-row', { hasText: 'My first idea' });
  await expect(saved).toBeVisible();
  await expect(saved).toHaveClass(/in-use/);
  expect(await page.evaluate(() => window.state.saved_systems.length)).toBe(1);
  await saved.locator('.sys-x').click();
  expect(await page.evaluate(() => window.state.saved_systems.length)).toBe(0);
});

test('Me points to the one place systems are compared', async ({ page }) => {
  await boot(page, { current_screen: 'me', solar_quotes: QUOTES, saved_systems: SAVED });
  await expect(page.locator('.me-quote')).toHaveCount(0);
  await page.locator('.me-row', { hasText: 'Compare systems' }).click();
  await expect(page.locator('#v7-sheet .sys-list')).toBeVisible();
});

import { test, expect } from '@playwright/test';
import { boot } from './support.js';

test('setup takes any panel count, battery and discount, not only the tiles', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.evaluate(() => { startFlow(); flowAnswer('bill', 250); flowAnswer('plan', 'EI-24'); });
  await page.locator('#flow-own-disc').fill('22'); await page.locator('.fl-own button').click();
  expect(await page.evaluate(() => state.baseline_discount_pct)).toBe(22);
  await page.evaluate(() => { flowAnswer('heat', 'heatpump'); flowAnswer('solar', 'thinking'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); });
  await page.locator('#flow-own-panels').fill('13'); await page.locator('.fl-own button').click();
  await page.locator('#flow-own-battery').fill('9'); await page.locator('.fl-own button').click();
  expect(await page.evaluate(() => [state.count_A + state.count_B, state.battery_kwh])).toEqual([13, 9]);
});

test('My system takes an exact roof direction in degrees', async ({ page }) => {
  await boot(page, { has_solar: true, considering_solar: true, count_A: 10, azimuth_A: 180, current_screen: 'result' });
  await page.evaluate(() => openMySystem());
  const deg = page.locator('#v7-sheet input[aria-label="Exact direction in degrees"]').first();
  await deg.fill('200'); await deg.dispatchEvent('change');
  expect(await page.evaluate(() => state.azimuth_A)).toBe(200);
});

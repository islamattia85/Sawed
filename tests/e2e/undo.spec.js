import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/** A change tried on the system is one tap from being undone, from the toast or the bar above the suggestions. */
const PLANNED = { has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 9 };

test('"Try it on my system" can be undone, back to the system as it was', async ({ page }) => {
  const errors = await boot(page, { ...PLANNED, current_screen: 'analytics', _an_tab: 'solar', _solar_more: true });
  const before = await page.evaluate(() => ({ a: window.state.count_A, b: window.state.count_B, batt: window.state.battery_kwh }));
  await page.evaluate(() => window.anTab('solar'));
  const tryBtn = page.locator('.v7-imp-btn', { hasText: 'Try it on my system' }).first();
  await expect(tryBtn).toBeVisible({ timeout: 15_000 });
  await tryBtn.click();
  const after = await page.evaluate(() => ({ a: window.state.count_A, b: window.state.count_B, batt: window.state.battery_kwh }));
  expect(after).not.toEqual(before);
  await expect(page.locator('.v7-undo')).toContainText('Tried');
  await page.locator('.v7-undo button', { hasText: 'Undo' }).click();
  expect(await page.evaluate(() => ({ a: window.state.count_A, b: window.state.count_B, batt: window.state.battery_kwh }))).toEqual(before);
  await expect(page.locator('.v7-undo')).toHaveCount(0);
  expect(errors).toEqual([]);
});

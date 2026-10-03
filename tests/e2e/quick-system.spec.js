import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const HOME = { has_solar: true, considering_solar: true, solar_planned: true, count_A: 6, count_B: 4, azimuth_A: 135, azimuth_B: 225, battery_kwh: 9, current_screen: 'result' };
const open = async (page) => {
  await page.evaluate(() => { setScreen('analytics'); anTab('solar'); });
  await page.locator('.v7-system .v7-chip', { hasText: 'panels' }).click();
  await expect(page.locator('#v7-sheet')).toContainText('Panels and battery');
};

test('the panels chip opens a quick change: each roof face and the battery, used only on "Use this"', async ({ page }) => {
  await boot(page, HOME);
  await open(page);
  const sheet = page.locator('#v7-sheet');
  await expect(sheet).toContainText('South-east face');
  await expect(sheet).toContainText('South-west face');
  await expect(sheet.getByRole('button', { name: 'Use this' })).toBeDisabled();
  await sheet.getByRole('group', { name: 'South-west face' }).getByRole('button', { name: 'More' }).click();
  await sheet.getByRole('group', { name: 'Battery' }).getByRole('button', { name: 'More' }).click();
  expect(await page.evaluate(() => [state.count_B, state.battery_kwh])).toEqual([4, 9]);   // a draft until used
  await sheet.getByRole('button', { name: 'Use this' }).click();
  expect(await page.evaluate(() => [state.count_A, state.count_B, state.battery_kwh])).toEqual([6, 5, 10]);
  await expect(page.locator('.v7-system')).toContainText('11 panels');
  await page.locator('.toast-undo').click();
  expect(await page.evaluate(() => [state.count_B, state.battery_kwh])).toEqual([4, 9]);
});

test('"Save as" keeps the change as a new system without using it', async ({ page }) => {
  await boot(page, HOME);
  await open(page);
  await page.locator('#v7-sheet').getByRole('group', { name: 'Battery' }).getByRole('button', { name: 'Fewer' }).click();
  await page.locator('#v7-sheet').getByRole('button', { name: 'Save as a new system' }).click();
  const r = await page.evaluate(() => [state.battery_kwh, state.saved_systems.at(-1).cfg.battery_kwh, state.saved_systems.at(-1).name]);
  expect(r).toEqual([9, 7, '10 panels + 7 kWh']);
});

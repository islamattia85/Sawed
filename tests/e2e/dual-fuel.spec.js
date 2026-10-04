import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const GAS_HOME = { heating_type: 'gas', baseline: 'BG-24', baseline_known: true, has_solar: false, considering_solar: false, ev_active: false, current_screen: 'result' };

test('a gas home with gas from the same supplier is warned before switching electricity away', async ({ page }) => {
  await boot(page, { ...GAS_HOME, gas_same_supplier: 'yes' });
  const best = await page.evaluate(() => getRecommendation().best.plan.supplier);
  test.skip(/Bord G/.test(best), 'best plan is with the same supplier');
  await expect(page.locator('.v7-evnote.is-warn')).toContainText('dual-fuel discount');
  await expect(page.locator('.v7-evnote.is-warn')).toContainText('Bord Gáis');
});

test('no warning when the gas is elsewhere, or not asked', async ({ page }) => {
  await boot(page, { ...GAS_HOME, gas_same_supplier: 'no' });
  await expect(page.locator('.v7-evnote.is-warn')).toHaveCount(0);
  await boot(page, { ...GAS_HOME, heating_type: 'heatpump', gas_same_supplier: 'yes' });
  await page.evaluate(() => openMyHome());
  await expect(page.locator('#v7-sheet')).not.toContainText('Gas with');
});

test('the answer is a setting in My home, and does not change any figure', async ({ page }) => {
  await boot(page, GAS_HOME);
  const before = await page.evaluate(() => getRecommendation().best.net);
  await page.evaluate(() => openMyHome());
  await page.locator('#v7-sheet select').filter({ has: page.locator('option[value="yes"]') }).selectOption('yes');
  expect(await page.evaluate(() => [state.gas_same_supplier, getRecommendation().best.net])).toEqual(['yes', before]);
});

test('setup asks about gas only for a gas home whose supplier sells gas', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.evaluate(() => { startFlow(); flowAnswer('bill', 250); flowAnswer('plan', 'BG-24'); flowAnswer('heat', 'gas'); });
  await expect(page.locator('.fl-opts')).toContainText('Yes, both with them');
  await page.screenshot({ path: '/tmp/claude-0/-home-user-Sawed/74c17acb-5048-514f-a9cb-512d72f36e1c/scratchpad/gas.png' });
  await page.locator('.fl-opt', { hasText: 'Yes, both with them' }).click();
  expect(await page.evaluate(() => state.gas_same_supplier)).toBe('yes');
  await page.evaluate(() => { flowAnswer('heat', 'heatpump'); });
  await expect(page.locator('.fl-opts')).not.toContainText('Yes, both with them');
});

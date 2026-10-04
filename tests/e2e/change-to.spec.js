import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const GAS = { heating_type: 'gas', baseline: 'BG-24', baseline_known: true, has_solar: false, considering_solar: false, ev_active: false, gas_same_supplier: 'yes', gas_bill_eur: 220, current_screen: 'result' };

test('more than one move worth making: a tile for each under "Change to:", biggest saving first', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-04T12:00:00Z'));
  await boot(page, GAS);
  const tiles = page.locator('.ct-tile');
  await expect(page.locator('.ct-k')).toHaveText('Change to:');
  expect(await tiles.count()).toBeGreaterThanOrEqual(2);
  const saves = (await tiles.locator('em').allInnerTexts()).map((t) => +t.replace(/[^0-9]/g, ''));
  expect(saves).toEqual([...saves].sort((a, b) => b - a));
  await expect(tiles.first()).toContainText('Gas and electricity');
  // One story: the hero's figure is the best tile's, and the bars are the same three choices.
  const hero = +(await page.locator('.v7-figure [data-countup-num]').innerText()).replace(/[^0-9]/g, '');
  const best = +(await tiles.first().locator('em').innerText()).replace(/[^0-9]/g, '');
  expect(best).toBe(hero);
  await expect(page.locator('.v7-ladder-k')).toHaveText('Gas and electricity, a year');
  await expect(page.locator('.df-card')).toHaveCount(0);
  await page.locator('#app-root').screenshot({ path: process.env.SHOT || '/dev/null' }).catch(() => {});
  await tiles.first().click();
  await expect(page.locator('#v7-sheet')).toContainText('ask for their dual fuel plan');
});

test('one move only: the plain switch button', async ({ page }) => {
  await boot(page, { ...GAS, heating_type: 'heatpump', gas_same_supplier: '', baseline: 'EI-24' });
  const n = await page.locator('.ct-tile').count();
  if (n === 0) await expect(page.locator('.v7-switch-btn')).toHaveCount(1);
  else expect(n).toBeGreaterThanOrEqual(2);
});

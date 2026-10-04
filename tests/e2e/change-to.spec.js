import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const GAS = { heating_type: 'gas', baseline: 'BG-24', baseline_known: true, has_solar: false, considering_solar: false, ev_active: false, gas_same_supplier: 'yes', gas_bill_eur: 220, current_screen: 'result' };
const num = (t) => +t.replace(/[^0-9]/g, '');

test('more than one move worth making: a switch button for each, stacked, biggest saving first', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-04T12:00:00Z'));
  await boot(page, GAS);
  const btns = page.locator('.ct-btn');
  expect(await btns.count()).toBe(2);
  await expect(btns.first()).toContainText('Switch both to');
  await expect(btns.nth(1)).toContainText('Switch electricity to');
  const hero = num(await page.locator('.v7-figure [data-countup-num]').innerText());
  expect(num(await btns.first().locator('small').innerText())).toBe(hero);
  await expect(page.locator('.v7-ladder-k')).toHaveText('Gas and electricity, a year');
  await page.locator('#app-root').screenshot({ path: '/tmp/claude-0/-home-user-Sawed/74c17acb-5048-514f-a9cb-512d72f36e1c/scratchpad/btn_gas.png' });
  await btns.first().click();
  await expect(page.locator('#v7-sheet')).toContainText('ask for their dual fuel plan');
});

test('planning solar on a dear plan: the best plan now, and the best once the panels are in', async ({ page }) => {
  await boot(page, { baseline: 'EI-24', heating_type: 'heatpump', has_solar: true, considering_solar: true, solar_planned: true, count_A: 14, battery_kwh: 10, ev_active: false, current_screen: 'result' });
  const pl = await page.evaluate(() => { const p = window.__sim.plannedLadder(); return { now: p.noSolar.plan.id, later: p.best.plan.id, base: state.baseline }; });
  const btns = page.locator('.ct-btn');
  if (pl.now !== pl.base) await expect(btns.first()).toContainText('Now: switch to');
  if (pl.later !== pl.now) await expect(page.locator('.ct-btn', { hasText: 'With the panels:' })).toHaveCount(1);
  await page.locator('#app-root').screenshot({ path: '/tmp/claude-0/-home-user-Sawed/74c17acb-5048-514f-a9cb-512d72f36e1c/scratchpad/btn_solar.png' });
});

test('one move only: the plain switch button', async ({ page }) => {
  await boot(page, { ...GAS, heating_type: 'heatpump', gas_same_supplier: '', baseline: 'EI-24' });
  await expect(page.locator('.ct-btn')).toHaveCount(0);
  await expect(page.locator('.v7-switch-btn')).toHaveCount(1);
});

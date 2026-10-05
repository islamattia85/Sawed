import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

const fresh = async (page) => { await isolate(page); await page.goto('/?fresh'); await page.waitForFunction(() => window.__bootSettled === true); };
const steps = (page) => page.evaluate(() => { const f = state._flow || {}; return (window.__flowSteps ? window.__flowSteps() : null); });

test('start offers two routes: a quick switch check, and the guided solar or EV setup', async ({ page }) => {
  await fresh(page);
  await expect(page.getByRole('button', { name: /Am I paying too much/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Planning solar, a battery or an EV/ })).toBeVisible();
});

test('quick route: bill, plan and heating only, then the answer with a way into the full picture', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Am I paying too much/ }).click();
  await page.evaluate(() => { flowAnswer('bill', 250); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('heat', 'heatpump'); flowAnswer('heattime', 'day'); });
  await expect(page.locator('.fl-reveal')).toBeVisible();
  await expect(page.locator('.fl-chip', { hasText: /Solar|EV/ })).toHaveCount(0);
  await page.locator('.fl-upgrade').click();
  // Straight on to the solar question, every answer kept.
  await expect(page.locator('.fl-q h2')).toHaveText('Solar panels?');
  await expect(page.locator('.fl-chip')).toHaveCount(7);
});

test('guided route: any direction, slope, a quote price and the grant are asked, and set', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Planning solar, a battery or an EV/ }).click();
  await page.evaluate(() => { flowAnswer('bill', 250); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('heat', 'heatpump'); flowAnswer('heattime', 'day'); flowAnswer('solar', 'thinking'); flowAnswer('where', 'east'); flowAnswer('house', 'semi'); });
  await expect(page.locator('.fl-q')).toContainText('North');
  await page.locator('#flow-own-roof').fill('200'); await page.locator('.fl-own button').click();
  await expect(page.locator('.fl-q h2')).toHaveText('How steep is the roof?');
  await page.evaluate(() => { flowAnswer('tilt', 30); flowAnswer('system', 'custom'); flowAnswer('panels', 12); flowAnswer('battery', 10); });
  await expect(page.locator('.fl-q h2')).toHaveText('Do you have a price?');
  await page.locator('#flow-own-price').fill('12500'); await page.locator('.fl-own button').click();
  await expect(page.locator('.fl-q h2')).toContainText('SEAI grant');
  await page.locator('.fl-opt', { hasText: /^No$/ }).click();
  await expect(page.locator('.fl-chose')).toHaveCount(0);
  const st = await page.evaluate(() => ({ az: state.azimuth_A, tilt: state.tilt_A, cost: state.install_cost, manual: state.cost_is_manual, grant: state.grant_seai, eligible: state.grant_eligible }));
  expect(st).toEqual({ az: 200, tilt: 30, cost: 12500, manual: true, grant: 0, eligible: false });
});

test('a guide price is labelled as one in My system', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => { startFlow('full'); flowAnswer('bill', 250); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('heat', 'heatpump'); flowAnswer('heattime', 'day'); flowAnswer('solar', 'thinking'); flowAnswer('where', 'east'); flowAnswer('house', 'semi'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); flowAnswer('system', 'custom'); flowAnswer('panels', 10); flowAnswer('battery', 5); flowAnswer('price', 0); flowAnswer('grant', 'yes'); flowAnswer('ev', 'no'); flowFinish(); openMySystem(); });
  await expect(page.locator('#v7-sheet .sy-net')).toContainText('Guide price');
});

import { test, expect } from '@playwright/test';
import { runScenario, SCENARIOS } from './run-scenario.js';

/**
 * The Solar page for a meter file with the panels in all of it (30 Oct 2026).
 * The model doesn't run those panels, so the page read its figures off it:
 * "Made by the panels · 0 kWh", "0% used at home, 0% sold" and 944 kWh sold,
 * beside a Profile saying 5,721 kWh made and 1,693 kWh sold. It now has what
 * the report and the share card have: what the readings show (netFileYear).
 */
const n0 = (v) => Math.round(v).toLocaleString('en-IE');

test('a meter file with panels: the Solar page shows what they made, kept and sold, as the readings do', async ({ page }) => {
  test.setTimeout(150000);
  await runScenario(page, SCENARIOS.find((s) => s.id === 'B2-hp_solar_batt'));
  const y = await page.evaluate(() => {
    const st = window.state, best = window.getBestPlan(), ny = window.__sim.netFileYear(best.plan.id);
    const sum = (a) => Array.from(a).reduce((x, v) => x + v, 0);
    return { ...ny, use: Object.values(st.bills).reduce((a, b) => a + b, 0), readings: Object.values(st.bills).reduce((a, b) => a + b, 0) - sum(window.CACHE.cons) + st._csv_export_kwh };
  });
  expect(y.made).toBeGreaterThan(1000);
  expect(Math.round(y.made)).toBe(Math.round(y.readings));

  await page.evaluate(() => window.anTab('solar'));
  const body = page.locator('body');
  await expect(body).toContainText(`Made by the panels · ${n0(y.made)} kWh`);
  await expect(body).toContainText(`Used by the home · ${n0(y.use)} kWh`);
  const kept = Math.max(0, y.made - y.sold);
  const pct = (a, b) => Math.round(a / Math.max(1, b) * 100);
  await expect(body).toContainText(`${pct(kept, y.made)}% used at home, ${pct(y.sold, y.made)}% sold`);
  await expect(body).toContainText(`Sold to the grid · ${pct(y.sold, y.made)}%`);
  await expect(body).toContainText(`${n0(y.sold)} kWh`);
  await expect(body).not.toContainText('Made by the panels · 0 kWh');

  // Profile says what the file sold; where the cheapest plan sells more (its
  // battery tops up at night), the share card says which plan its figure is on.
  const { share, fileSold } = await page.evaluate(() => ({ share: window.__shareText(true), fileSold: window.state._csv_export_kwh }));
  if (Math.abs(y.sold - fileSold) > 20) expect(share).toContain(`Sells (cheapest plan): ${n0(y.sold)} kWh`);
  else expect(share).toContain(`Sells: ${n0(y.sold)} kWh`);
});

test('a home that didn\'t get the grant: its solar card says "no grant", not "after grant"', async ({ page }) => {
  test.setTimeout(150000);
  await runScenario(page, SCENARIOS.find((s) => s.id === 'B2-hp_solar_batt'));
  await page.evaluate(() => { window.state.grant_seai = 0; window.setScreen('result'); });
  const card = page.locator('.hc', { hasText: 'Your solar panels' });
  await expect(card).toContainText('no grant');
  await expect(card).not.toContainText('after grant');
  await page.evaluate(() => { window.state.grant_seai = 1800; window.setScreen('result'); });
  await expect(card).toContainText('after grant');
});

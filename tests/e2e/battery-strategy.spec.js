import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The engine may not overwrite the user's battery strategy.
 *
 * "Battery arbitrage keeps deselecting whenever I click things" — and it did.
 * The state sanitiser enforced "no battery means no grid-charging arbitrage" by
 * *writing* self-consume into state. Every routine that trials a batteryless
 * design — the twelve-design sweep, the recommended-system search, the report
 * levers — sets battery_kwh to 0, invalidates, and restores the battery
 * afterwards. None of them restored a setting they never knowingly touched, so
 * the user's choice was destroyed as a side effect of the app drawing a screen.
 *
 * The Solar tab calls bestDesign() during its own render, so the setting was
 * already gone by the time the screen finished loading.
 *
 * strategy_mode is now a preference the engine never writes. Whether it is in
 * force is derived at the point of use, which is what "no battery means no
 * arbitrage" always was.
 */

const ARBITRAGE = {
  current_screen: 'solar', has_solar: true, considering_solar: true,
  count_A: 12, battery_kwh: 5, panel_w: 440, tilt_A: 35, azimuth_A: 180,
  strategy_mode: 'arbitrage', charge_from_grid: true,
  // A current-version save: the one-time upgrade to Automatic applies only to
  // older saves, whose strategy was often a leftover rather than a choice.
  schema_version: 3,
};

const strategy = (page) => page.evaluate(() => ({
  mode: window.state.strategy_mode,
  grid: window.state.charge_from_grid,
}));

test('arbitrage survives the solar screen rendering itself', async ({ page }) => {
  const errors = await boot(page, ARBITRAGE);
  // No interaction at all — just arriving is enough to trigger the design sweep.
  await page.waitForTimeout(2500);
  expect(await strategy(page), 'the setting was gone before the screen finished loading')
    .toEqual({ mode: 'arbitrage', grid: true });
  expect(errors).toEqual([]);
});

test('arbitrage survives every routine that trials a batteryless design', async ({ page }) => {
  await boot(page, ARBITRAGE);

  for (const call of ['bestDesign', 'sweepGoalDesigns', 'getRecommendation']) {
    await page.evaluate((fn) => window[fn] && window[fn](), call);
    expect(await strategy(page), `${call}() overwrote the user's battery strategy`)
      .toEqual({ mode: 'arbitrage', grid: true });
  }
});

test('arbitrage survives moving around the app', async ({ page }) => {
  await boot(page, ARBITRAGE);
  for (const screen of ['result', 'plans', 'solar', 'analytics', 'monitor']) {
    await page.evaluate((s) => window.setScreen(s), screen);
    await page.waitForTimeout(400);
    expect(await strategy(page), `visiting ${screen} lost the setting`)
      .toEqual({ mode: 'arbitrage', grid: true });
  }
});

test('with no battery the strategy is simply not in force, and is not erased', async ({ page }) => {
  await boot(page, { ...ARBITRAGE, battery_kwh: 0 });

  // The preference is kept…
  expect(await strategy(page)).toEqual({ mode: 'arbitrage', grid: true });
  // …but nothing claims arbitrage is running without a battery to run it.
  expect(await page.evaluate(() => window.arbitrageOn && window.arbitrageOn())).toBe(false);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/arbitrage is on/i);

  // Fit a battery and the preference the user set is honoured again, with no
  // need to re-select it.
  await page.evaluate(() => { window.state.battery_kwh = 5; window.invalidate(); window.renderApp(); });
  expect(await page.evaluate(() => window.arbitrageOn())).toBe(true);
});

test('the suggested system is told apart from the one being modelled', async ({ page }) => {
  await boot(page, { ...ARBITRAGE, count_A: 12, battery_kwh: 5 });
  // Lives in My system's list, above the controls it would change.
  await page.evaluate(() => window.openMySystem());
  const list = page.locator('.sys-list');
  await expect(list.locator('.sys-g-suggested .sys-row').first()).toBeVisible({ timeout: 60_000 });
  // The reader's own system is its own row, marked in use.
  await expect(list.locator('.sys-row.in-use')).toContainText(/12 panels[\s\S]*5 kWh battery/);
  // Every suggestion has its spec and the same four figures.
  const rows = list.locator('.sys-g-suggested .sys-row');
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  for (const r of await rows.all()) await expect(r.locator('.sys-m')).toHaveCount(4, { timeout: 60_000 });
  // No two suggestions offer the same system.
  const all = await list.locator('.sys-g-suggested .sys-row .sys-l > small:first-of-type').allTextContents();
  expect(new Set(all).size).toBe(all.length);
});

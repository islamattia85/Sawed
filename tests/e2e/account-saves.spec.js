// @ts-check
/**
 * Account saves (11 Oct 2026). A save is queued on every change, a screen
 * change too, and each one sent the whole home to the account, meter
 * readings and all. The app now sends a copy only when it differs from the
 * last one sent, so moving around the app must leave the account's copy as
 * it was. If a screen starts keeping its own state in the household, this
 * says which key, so it can go in NO_SYNC (src/sync.js).
 */
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const HOME = { has_solar: true, solar_planned: false, considering_solar: true, count_A: 10, panel_w: 460, azimuth_A: 157, tilt_A: 35, battery_kwh: 9,
  heating_type: 'heatpump', region: 'south', baseline: 'EN-EV', baseline_known: true, bimonthly_bill_eur: 300, usage_input_mode: 'bill', grid_charge_now: 'yes', current_screen: 'result' };

test('moving around the app leaves the account’s copy of the home unchanged', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page, HOME);
  const copy = () => page.evaluate(() => JSON.stringify(window.__sync.cloudCopy(window.state)));
  const tour = async () => { for (const go of [
    "setScreen('plans')", "setScreen('analytics'); anTab('bill')", "anTab('hours')", "anTab('solar')", "anTab('car')", "anTab('accuracy')",
    "setScreen('updates')", "setScreen('profile')", "setScreen('more')", "setScreen('privacy')", "setScreen('ranking')",
    "setScreen('result'); v7Sheet('home')", "v7Sheet('system')", "v7Sheet(null); setScreen('result')",
  ]) {
    await page.evaluate((code) => { new Function(code)(); }, go);
    await page.waitForTimeout(150);
  } await page.waitForTimeout(1800); };
  // The first time round marks the alerts and score as seen: a real change, made once, and synced so
  // another device doesn't show them as new. The second time round must change nothing.
  await tour();
  const before = await copy();
  await tour();
  const after = await copy();
  if (after !== before) {
    const a = JSON.parse(before), b = JSON.parse(after);
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    expect(keys, 'these keys changed just by moving around; screen-only keys belong in NO_SYNC').toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('a real change to the home does change the account’s copy', async ({ page }) => {
  await boot(page, HOME);
  const copy = () => page.evaluate(() => JSON.stringify(window.__sync.cloudCopy(window.state)));
  const before = await copy();
  await page.evaluate(() => { window.state.battery_kwh = 13.5; window.saveState(); });
  expect(await copy()).not.toBe(before);
});

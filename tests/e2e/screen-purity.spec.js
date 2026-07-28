import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Looking at a screen must not change the answer.
 *
 * "Whenever I click Solar it removes arbitrage, and if I click again it brings
 * it back." Five attempts to reproduce that by watching strategy_mode found
 * nothing, because strategy_mode was never the thing moving. Opening the Solar
 * tab runs the optimisation advisor, which measures each lever by turning it
 * OFF and back on — and the export-payments lever was missing from the restore
 * list. So arriving on the tab left export registration switched off, deleting
 * 2,448 kWh/yr of export income from every figure computed afterwards. Payback
 * on a 10-panel, 9 kWh system read 14.4 years instead of 9.3, and the advisor's
 * own rows flipped between "on" and "switch it on" on alternate visits, which
 * is what a reader sees as a setting deselecting itself.
 *
 * The lesson is not "add export_enabled to the list" — that list has been wrong
 * three times now. It is that a screen render is not allowed to move a number.
 */

const HOME = {
  current_screen: 'result',
  has_solar: true, considering_solar: true,
  count_A: 10, battery_kwh: 9, panel_w: 440, tilt_A: 35, azimuth_A: 180,
  install_cost: 12000, grant_seai: 1800,
  strategy_mode: 'arbitrage', charge_from_grid: true,
};

/** The figures a reader would notice, read straight from the engine. */
const figures = (page) => page.evaluate(() => {
  const sum = (a) => { let t = 0; for (const v of a) t += v; return t; };
  const scen = window.computeSolarPaybackScenarios();
  const cur = window.state.ev_active ? scen.withEv : scen.withoutEv;
  const best = window.getBestPlan();
  return {
    payback: +cur.payback.toFixed(2),
    solarBenefit: Math.round(cur.solarBenefit),
    bestNet: Math.round(best.net),
    exportKwh: Math.round(sum(best.sim.grid_export)),
    exportEnabled: window.state.export_enabled !== false,
    arbitrageOn: window.arbitrageOn(),
  };
});

test('visiting every screen leaves every figure exactly where it was', async ({ page }) => {
  const errors = await boot(page, HOME);
  const before = await figures(page);
  expect(before.exportKwh, 'this home should be exporting, or the test proves nothing')
    .toBeGreaterThan(0);

  for (const screen of ['solar', 'plans', 'monitor', 'analytics', 'more', 'refine', 'result']) {
    await page.evaluate((s) => window.setScreen(s), screen);
    await page.waitForTimeout(screen === 'solar' ? 2200 : 400);
    const after = await figures(page);
    const moved = Object.keys(before).filter((k) => before[k] !== after[k])
      .map((k) => `${k}: ${before[k]} -> ${after[k]}`);
    expect(moved, `merely looking at "${screen}" changed the numbers`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test('the payback on screen is the payback the engine computed', async ({ page }) => {
  await boot(page, { ...HOME, current_screen: 'solar' });
  await page.waitForTimeout(2200);

  const { shown, engine } = await page.evaluate(() => {
    const el = document.querySelector('.qr-value');
    const m = el && el.textContent.match(/([\d.]+)\s*yr/);
    const scen = window.computeSolarPaybackScenarios();
    const cur = window.state.ev_active ? scen.withEv : scen.withoutEv;
    return { shown: m ? parseFloat(m[1]) : null, engine: +cur.payback.toFixed(1) };
  });

  // These disagreed by five years — the hero showed a figure computed before
  // the tab had finished quietly switching export payments off.
  expect(shown, 'no payback figure on the solar screen').not.toBeNull();
  expect(Math.abs(shown - engine), `screen says ${shown} yr, engine says ${engine} yr`)
    .toBeLessThanOrEqual(0.15);
});

test('export payments survive the screen that measures them', async ({ page }) => {
  await boot(page, { ...HOME, current_screen: 'solar' });
  await page.waitForTimeout(2200);

  // The advisor prices this lever by switching it off. It has to switch it back.
  expect(await page.evaluate(() => window.state.export_enabled)).not.toBe(false);
  const exported = await page.evaluate(() => {
    const sum = (a) => { let t = 0; for (const v of a) t += v; return t; };
    return Math.round(sum(window.getBestPlan().sim.grid_export));
  });
  expect(exported, 'export was left switched off by the solar screen').toBeGreaterThan(0);
});

import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Simulating a hypothetical must not change the user's home.
 *
 * The engine reads global state, so every "what if" — no panels, bigger
 * battery, this lever flipped — is asked by mutating `state`, simulating, and
 * putting it back. Putting it back was done by hand at five call sites, each
 * with its own list of fields, and the same bug shipped twice: generating a
 * report permanently switched the battery to self-consume, and arbitrage
 * switched itself off while the reader clicked around. Both were one field
 * missing from one list, restoring silently and successfully without it.
 *
 * There is one list now. This test does not care which fields are on it — it
 * asserts the property that matters: after anything that runs a hypothetical,
 * every setting the user chose is exactly as they left it.
 */

const HOME = {
  current_screen: 'solar',
  has_solar: true, considering_solar: true,
  count_A: 12, count_B: 0, battery_kwh: 5, panel_w: 440, tilt_A: 35, azimuth_A: 180,
  strategy_mode: 'arbitrage', charge_from_grid: true,
  hot_water_strategy: 'smart', heating_type: 'heatpump',
  ev_active: true, ev_in_bill: false, ev_km_per_year: 16500,
  install_cost: 12000, grant_seai: 1800, region: 'east', baseline: 'EI-24',
};

/**
 * Everything the user chose, as the app has it right now.
 *
 * Deliberately an explicit list rather than SIM_FIELDS: comparing against the
 * list under test is circular — drop a field from SIM_FIELDS and this would
 * stop checking it at the same moment it stopped being restored.
 */
const USER_SETTINGS = [
  'has_solar', 'count_A', 'count_B', 'battery_kwh', 'panel_w', 'tilt_A', 'azimuth_A',
  'strategy_mode', 'charge_from_grid', 'hot_water_strategy', 'heating_type',
  'ev_active', 'ev_in_bill', 'ev_km_per_year',
  'install_cost', 'grant_seai', 'region', 'baseline', 'chosen_plan',
];

const settings = (page) => page.evaluate((keys) => {
  const out = {};
  for (const k of keys) out[k] = JSON.stringify(window.state[k]);
  return out;
}, USER_SETTINGS);

const HYPOTHETICALS = [
  ['bestDesign', () => window.bestDesign()],
  ['sweepGoalDesigns', () => window.sweepGoalDesigns()],
  ['getRecommendation', () => window.getRecommendation()],
  ['runScenario(no solar)', () => window.cachedScenario(false, window.state.ev_active)],
  ['computeScenarioRange', () => window.computeScenarioRange && window.computeScenarioRange()],
  ['computeOptimisations', () => window.computeOptimisations && window.computeOptimisations()],
];

test('no hypothetical changes a single setting the user chose', async ({ page }) => {
  await boot(page, HOME);
  const before = await settings(page);

  for (const [label, fn] of HYPOTHETICALS) {
    await page.evaluate(fn);
    const after = await settings(page);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k])
      .map((k) => `${k}: ${before[k]} -> ${after[k]}`);
    expect(changed, `${label}() changed the user's settings`).toEqual([]);
  }
});

test('generating a report leaves the home exactly as it was', async ({ page }) => {
  await boot(page, HOME);
  const before = await settings(page);

  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  await download;

  expect(await settings(page), 'the report levers left something behind').toEqual(before);
});

test('a hypothetical that throws still puts the state back', async ({ page }) => {
  await boot(page, HOME);
  const before = await settings(page);

  // The restore lives in a finally block precisely so a failure mid-trial
  // cannot leave the reader looking at a home they do not own.
  await page.evaluate(() => {
    try {
      window.withSimState({ battery_kwh: 0, count_A: 0, has_solar: false }, () => {
        throw new Error('simulated failure');
      });
    } catch (e) { /* expected */ }
  });

  expect(await settings(page), 'a thrown hypothetical stranded the user in it').toEqual(before);
});

test('the field list actually covers what the engine mutates', async ({ page }) => {
  await boot(page, HOME);

  // Anything a hypothetical writes must be on the list, or it will not be
  // restored. Watch state during a sweep and compare.
  const missing = await page.evaluate(() => {
    const seen = new Set();
    const real = window.state;
    const proxied = new Proxy(real, {
      set(t, k, v) { seen.add(String(k)); t[k] = v; return true; },
    });
    // The sweep memoises. Without busting the cache it returns instantly,
    // writes nothing, and this test passes while proving nothing — which is
    // exactly what it did on the first attempt.
    window.CACHE._goalSweep_ck = null;
    window.CACHE._goalSweep = null;
    window.state = proxied;
    try { window.sweepGoalDesigns(); window.bestDesign(); } finally { window.state = real; }
    if (!seen.size) throw new Error('the hypothetical wrote nothing — this test is not exercising anything');
    const covered = new Set(window.SIM_FIELDS);
    // Cache and view-only bookkeeping is not a user setting.
    return [...seen].filter((k) => !covered.has(k) && !k.startsWith('_'));
  });

  expect(missing, `written during a hypothetical but not on SIM_FIELDS: ${missing.join(', ')}`)
    .toEqual([]);
});

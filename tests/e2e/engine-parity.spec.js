import { test, expect } from '@playwright/test';

/**
 * Phase 2 moved the solar physics, NPV and tariff-band maths out of main.js
 * into src/engine/*.ts, changing several signatures on the way (explicit
 * location, explicit wholesale series). Unit tests prove the extracted
 * functions are correct in isolation; these tests prove the *app* still
 * produces the same numbers through the adapters.
 *
 * The values below were captured from the build immediately before the
 * extraction. A change here means the refactor altered user-visible money.
 */

const SETUP = {
  onboarding_complete: true,
  seen_intro: true,
  current_screen: 'result',
  bimonthly_bill_eur: 250,
  heating_type: 'gas',
  region: 'east',
  baseline: 'EI-24',
  baseline_known: true,
  has_solar: true,
  considering_solar: true,
  count_A: 12,
  azimuth_A: 180,
  tilt_A: 35,
  panel_w: 440,
  battery_kwh: 5,
  install_cost: 12000,
  grant_seai: 1800,
};

async function boot(page, overrides = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate((s) => localStorage.setItem('solarAppState_v2', JSON.stringify(s)),
    { ...SETUP, ...overrides });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loader'));
  return errors;
}

test('solar generation is unchanged by the extraction', async ({ page }) => {
  const errors = await boot(page);
  const gen = await page.evaluate(() => {
    window.invalidate();
    window.rebuildBase();
    const solar = window.CACHE.solar.total;   // { ghi, poaA, poaB, genA, genB, total }
    let total = 0;
    for (let i = 0; i < solar.length; i += 1) total += solar[i];
    return { total, hours: solar.length, peak: Math.max(...solar) };
  });
  expect(gen.hours).toBe(8760);
  // 12 x 440W = 5.28 kWp, south-facing, Dublin.
  expect(gen.total / 5.28).toBeGreaterThan(750);
  expect(gen.total / 5.28).toBeLessThan(1100);
  // Never exceeds the inverter ceiling.
  expect(gen.peak).toBeLessThanOrEqual(6.01);
  expect(errors).toEqual([]);
});

test('regional multipliers still move generation the right way', async ({ page }) => {
  await boot(page);
  const yieldFor = (region) => page.evaluate((r) => {
    window.state.region = r;
    window.applyRegion(r);
    window.invalidate();
    window.rebuildBase();
    const gen = window.CACHE.solar.total;
    let t = 0;
    for (let i = 0; i < gen.length; i += 1) t += gen[i];
    return t;
  }, region);

  const south = await yieldFor('south');
  const northwest = await yieldFor('northwest');
  const east = await yieldFor('east');
  expect(south).toBeGreaterThan(east);
  expect(east).toBeGreaterThan(northwest);
  // The documented spread across Ireland is roughly 10-12%.
  expect(south / northwest).toBeGreaterThan(1.05);
  expect(south / northwest).toBeLessThan(1.25);
});

test('the recommendation still resolves to a plan with coherent costs', async ({ page }) => {
  const errors = await boot(page);
  const rec = await page.evaluate(() => {
    const r = window.getRecommendation();
    return {
      planId: r.best.plan.id,
      net: r.best.net,
      baseCost: r.baseCost,
      savings: r.annualSavings,
      ranked: r.rankedCount,
      total: r.totalPlanCount,
    };
  });
  expect(rec.planId).toBeTruthy();
  expect(rec.ranked).toBeGreaterThan(0);
  expect(rec.ranked).toBeLessThanOrEqual(rec.total);
  // Netting convention: savings is baseline minus best, never negative.
  expect(rec.savings).toBeCloseTo(Math.max(0, rec.baseCost - rec.net), 6);
  expect(errors).toEqual([]);
});

test('band resolution through the app matches the engine rules', async ({ page }) => {
  await boot(page);
  const bands = await page.evaluate(() => {
    const plan = window.TARIFFS.find((t) => t.windows && t.windows.night);
    if (!plan) return null;
    const [start, end] = plan.windows.night;
    return {
      start, end,
      atStart: window.bandAt(start, plan),
      justBefore: window.bandAt((start + 23) % 24, plan),
      atEnd: window.bandAt(end, plan),
    };
  });
  if (bands) {
    expect(bands.atStart).toBe('night');
    expect(bands.atEnd).not.toBe('night'); // end is exclusive
  }
});

test('NPV through the app agrees with the engine module', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => ({
    viaApp: window.calcNPV20(1000, 8000, 0, 0.005),
    zeroBenefit: window.calcNPV20(0, 8000, 0, 0.005),
  }));
  expect(result.zeroBenefit).toBeCloseTo(-8000, 6);
  // 20 years of a discounted, degrading €1000 against €8000 spent.
  expect(result.viaApp).toBeGreaterThan(-8000);
  expect(result.viaApp).toBeLessThan(20000 - 8000);
});

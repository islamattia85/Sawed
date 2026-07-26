import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * A hand-picked plan has to reach everything, not just the screen it was picked
 * on. The engine, the result screen, the stored state and the report all read
 * the same accessor, so these tests drive the real app and check each surface
 * rather than trusting that one call site was enough.
 */

test('choosing a plan replaces the recommendation everywhere, and clearing restores it', async ({ page }) => {
  const errors = await boot(page);

  const before = await page.evaluate(() => {
    const rec = window.getRecommendation();
    return {
      best: rec.best.plan.id,
      manual: rec.isManualChoice,
      second: rec.ranked[1].plan.id,
      secondNet: Math.round(rec.ranked[1].net),
      cheapestNet: Math.round(rec.cheapest.net),
    };
  });
  expect(before.manual).toBe(false);
  expect(before.second).not.toBe(before.best);

  await page.evaluate((id) => window.choosePlan(id), before.second);

  const after = await page.evaluate(() => {
    const rec = window.getRecommendation();
    const bp = window.getBestPlan();
    return {
      recBest: rec.best.plan.id,
      enginePlan: bp.plan.id,
      isChosen: bp.isChosen,
      manual: rec.isManualChoice,
      rank: rec.chosenRank,
      premium: Math.round(rec.choicePremium),
      cheapest: rec.cheapest.plan.id,
      stored: JSON.parse(localStorage.getItem('solarAppState_v2')).chosen_plan,
    };
  });

  // The choice is what the app acts on...
  expect(after.recBest).toBe(before.second);
  expect(after.enginePlan).toBe(before.second);
  expect(after.isChosen).toBe(true);
  expect(after.manual).toBe(true);
  expect(after.rank).toBe(2);
  expect(after.stored).toBe(before.second);
  // ...while the ranking itself is untouched, and the premium is the real gap.
  expect(after.cheapest).toBe(before.best);
  expect(after.premium).toBe(before.secondNet - before.cheapestNet);

  // It survives a reload and is stated on the result screen, so a figure
  // computed on a non-cheapest plan can never look like our advice.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loader'));
  await expect(page.locator('.choice-strip')).toBeVisible();
  await expect(page.locator('.plan-compare')).toContainText('Your chosen plan');

  await page.evaluate(() => window.clearChosenPlan());
  const cleared = await page.evaluate(() => {
    const rec = window.getRecommendation();
    return { best: rec.best.plan.id, manual: rec.isManualChoice, stored: window.state.chosen_plan };
  });
  expect(cleared.best).toBe(before.best);
  expect(cleared.manual).toBe(false);
  expect(cleared.stored).toBeFalsy();

  expect(errors).toEqual([]);
});

test('the chosen plan is the one the report is built on', async ({ page }) => {
  const errors = await boot(page);
  const second = await page.evaluate(() => window.getRecommendation().ranked[1].plan.id);
  await page.evaluate((id) => window.choosePlan(id), second);

  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);

  const after = await page.evaluate(() => window.getBestPlan().plan.id);
  expect(after).toBe(second);
  expect(errors).toEqual([]);
});

/**
 * Generating a report used to change the user's settings.
 *
 * The levers re-run the simulation with one input altered, and one of them sets
 * battery_kwh to 0. Rebuilding then runs the state sanitizer, which forces
 * strategy_mode to 'self-consume' and clears charge_from_grid whenever there is
 * no battery — and restoring the battery did not undo that. Every figure the
 * user saw after downloading a report was computed on a strategy they never
 * selected.
 */
test('generating a report leaves the user’s settings exactly as they were', async ({ page }) => {
  const errors = await boot(page);

  const snapshot = () => page.evaluate(() => ({
    strategy: window.state.strategy_mode,
    chargeFromGrid: window.state.charge_from_grid,
    hotWater: window.state.hot_water_strategy,
    battery: window.state.battery_kwh,
    panels: window.state.count_A,
    plan: window.getRecommendation().best.plan.id,
    net: Math.round(window.getRecommendation().best.net),
  }));

  const before = await snapshot();
  expect(before.strategy).toBe('arbitrage');
  expect(before.chargeFromGrid).toBe(true);

  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  await download;

  expect(await snapshot()).toEqual(before);
  expect(errors).toEqual([]);
});

/**
 * The choice has to be reachable from where the plan is quoted. It first
 * shipped only on the plan-detail screen — three taps deep — so from the result
 * and solar screens, which are where people actually read the number, there was
 * no way to change it.
 */
test('the plan can be chosen from the solar screen, near the top', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'solar' });

  // The plan block must sit within reach of the payback headline, not below
  // the day inspector two screens down.
  const top = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('.section-title')].find((e) => /Best plan/i.test(e.textContent));
    return sec ? sec.getBoundingClientRect().top + window.scrollY : null;
  });
  expect(top, 'the plan block is missing from the solar screen').not.toBeNull();
  expect(top).toBeLessThan(900);

  await page.getByRole('button', { name: /different plan|Change plan/i }).first().click();
  await expect(page.locator('#plan-picker')).toBeVisible();

  const third = await page.evaluate(() => window.getRecommendation().ranked[2].plan.id);
  await page.locator('.pp-row').nth(2).click();

  await expect(page.locator('#plan-picker')).toHaveCount(0);
  const after = await page.evaluate(() => ({
    best: window.getBestPlan().plan.id,
    rank: window.getRecommendation().chosenRank,
  }));
  expect(after.best).toBe(third);
  expect(after.rank).toBe(3);
  await expect(page.locator('.choice-strip')).toBeVisible();

  expect(errors).toEqual([]);
});

test('the picker is reachable from the result screen too', async ({ page }) => {
  const errors = await boot(page);
  await page.getByRole('button', { name: /different plan|Change plan/i }).first().click();
  await expect(page.locator('#plan-picker')).toBeVisible();
  const rows = await page.locator('.pp-row').count();
  const ranked = await page.evaluate(() => window.getRecommendation().ranked.length);
  expect(rows).toBe(ranked);
  expect(errors).toEqual([]);
});

/**
 * Choosing a dearer plan must never shorten solar payback.
 *
 * runScenario() prices two worlds — with the panels and without — and takes the
 * difference. When the hand-picked plan leaked into the no-solar branch as well,
 * the counterfactual was priced on a tariff chosen for its export rate, which a
 * household without panels would never be on. That inflated the gap: on a
 * 10-panel, 9 kWh system, picking the second-ranked plan turned a 10.0-year
 * payback into 6.0 — an apparent 40% improvement bought by spending more.
 */
test('picking a costlier plan lengthens payback, never shortens it', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'solar', count_A: 10, battery_kwh: 9 });

  const payback = () => page.evaluate(() => {
    const el = document.querySelector('.qr-value');
    const m = el && el.textContent.match(/([\d.]+)\s*yr/);
    return m ? parseFloat(m[1]) : null;
  });

  const base = await payback();
  expect(base, 'no payback figure on the solar screen').not.toBeNull();

  const ranked = await page.evaluate(() => window.getRecommendation().ranked.slice(0, 4)
    .map((r) => ({ id: r.plan.id, net: r.net })));

  let previous = base;
  for (const plan of ranked.slice(1)) {
    await page.evaluate((id) => window.choosePlan(id), plan.id);
    const now = await payback();
    expect(now, `payback vanished after choosing ${plan.id}`).not.toBeNull();
    // Dearer plan, longer payback — allow a hair of float noise, nothing more.
    expect(now, `${plan.id} (€${Math.round(plan.net)}/yr) shortened payback from ${base} to ${now}`)
      .toBeGreaterThanOrEqual(base - 0.05);
    previous = now;
  }
  expect(previous).toBeGreaterThanOrEqual(base - 0.05);
  expect(errors).toEqual([]);
});

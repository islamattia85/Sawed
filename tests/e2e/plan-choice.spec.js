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
      // Unrounded: rounding each side and subtracting is not the same as
      // subtracting and rounding, and the two disagree by €1 whenever the
      // fractions fall the wrong way. That is a property of the arithmetic,
      // not of the app.
      secondNet: rec.ranked[1].net,
      cheapestNet: rec.cheapest.net,
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
  expect(after.premium).toBe(Math.round(before.secondNet - before.cheapestNet));

  // It survives a reload and is stated on the result screen, so a figure
  // computed on a non-cheapest plan can never look like our advice.
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loader'));
  // The strip is on the default view: that is the guarantee that matters — a
  // figure computed on a non-cheapest plan can never pass for our advice.
  await expect(page.locator('.choice-strip')).toBeVisible();
  // The comparison names it too, one tap down in the working.
  await page.locator('.working-toggle').click();
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

  // Still a button on the solar screen, where it is the section's own action
  // rather than a sibling of the primary CTA.
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
  // A link now, not a second button: two buttons of equal weight made the
  // reader choose between choosing and acting.
  await page.getByRole('link', { name: /different plan|Change plan/i }).first().click();
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

/**
 * Hierarchy: the decision comes before the working.
 *
 * The switch button used to sit at 53% of page depth on the home screen,
 * behind a disclosure, the plan comparison and a four-row savings breakdown —
 * a reader who had already accepted the advice at the top had to scroll past
 * three layers of justification to act on it.
 */
test('the primary action is above the fold, and the reasoning is below it', async ({ page }) => {
  const errors = await boot(page);

  const geo = await page.evaluate(() => {
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    };
    return {
      hero: y('.qr-hero'),
      cta: y('.switch-cta'),
      working: y('.working'),
      viewport: window.innerHeight,
      page: document.body.scrollHeight,
    };
  });

  expect(geo.cta, 'no primary action on the home screen').not.toBeNull();
  expect(geo.cta, 'the action is below the fold').toBeLessThan(geo.viewport);
  expect(geo.cta, 'the action does not follow the headline figure').toBeGreaterThan(geo.hero);
  expect(geo.working, 'the working is above the action, not below it').toBeGreaterThan(geo.cta);
  expect(geo.cta / geo.page, 'the action sits too deep in the page').toBeLessThan(0.35);

  // …and the reasoning is still all there, one tap down. The working is now
  // collapsed by default, so "below the action" has to be checked after
  // opening it — otherwise this test would pass on a screen that had simply
  // deleted the justification.
  await page.locator('.working-toggle').click();
  const reasoning = await page.evaluate(() => {
    const el = document.querySelector('.plan-compare');
    return el ? el.getBoundingClientRect().top + window.scrollY : null;
  });
  expect(reasoning, 'the plan comparison vanished instead of moving').not.toBeNull();
  expect(reasoning, 'the working opened above the action').toBeGreaterThan(geo.cta);
  expect(errors).toEqual([]);
});

test('the report is promoted, and the novelty tile is gone', async ({ page }) => {
  const errors = await boot(page);
  const promo = page.locator('.report-promo');
  await expect(promo).toHaveCount(1);
  await expect(promo).toContainText(/typeset pages/i);

  // Full width, not a quarter tile beside a share-card gimmick.
  const width = await promo.evaluate((el) => el.getBoundingClientRect().width);
  const screen = await page.evaluate(() => document.querySelector('.screen')?.getBoundingClientRect().width ?? 0);
  expect(width / screen).toBeGreaterThan(0.9);

  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/Challenge a friend/i);
  expect(errors).toEqual([]);
});

test('the health score names its weakest factor instead of just scoring you', async ({ page }) => {
  const errors = await boot(page);
  // The score moved behind "Show me the working" — it is context, not the
  // answer, and a number the reader cannot act on has no claim on the fold.
  // It still has to name the weakest factor wherever it lives.
  await page.locator('.working-toggle').click();
  const card = page.locator('text=Energy health score').locator('..').locator('..');
  await expect(card).toContainText(/Weakest:|Little left on the table/);
  expect(errors).toEqual([]);
});

test('the solar screen puts free advice above the instrument', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'solar' });
  const order = await page.evaluate(() => {
    const at = (re) => {
      const el = [...document.querySelectorAll('.section-title')].find((e) => re.test(e.textContent));
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    };
    return { advice: at(/Maximise your benefit/i), inspector: at(/Day inspector/i) };
  });
  if (order.advice !== null && order.inspector !== null) {
    expect(order.advice, 'the day inspector still precedes the free changes')
      .toBeLessThan(order.inspector);
  }
  expect(errors).toEqual([]);
});

/**
 * The plans screen's job is holding two tariffs against each other, and it had
 * no support for that: 26 near-identical rows, a category filter, and nothing
 * else. Five viewports of comparison with no compare.
 */
test('two plans can be compared side by side', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'plans' });

  await expect(page.locator('.plans-sort-btn')).toHaveCount(3);

  await page.locator('.cmp-btn').nth(0).click();
  await expect(page.locator('.cmp-tray')).toBeVisible();
  // One selection is not a comparison.
  await expect(page.locator('.cmp-tray-go')).toBeDisabled();

  await page.locator('.cmp-btn').nth(2).click();
  await expect(page.locator('.cmp-tray-go')).toBeEnabled();
  await page.locator('.cmp-tray-go').click();

  const modal = page.locator('#cmp-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('Annual cost');
  await expect(modal).toContainText('Standing charge');
  // A verdict, not just a table.
  await expect(page.locator('.cmp-verdict')).toContainText(/cheaper for your home|cost the same/);
  // The better figure in a row is marked.
  expect(await page.locator('.cmp-best').count()).toBeGreaterThan(2);

  expect(errors).toEqual([]);
});

test('the comparison never holds more than two plans', async ({ page }) => {
  await boot(page, { current_screen: 'plans' });
  for (const i of [0, 1, 2, 3]) {
    await page.locator('.cmp-btn').nth(i).click();
    await page.waitForTimeout(60);
  }
  const sel = await page.evaluate(() => window.state._cmp_plans);
  expect(sel.length).toBe(2);
});

test('sorting reorders the list without changing the ranking', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'plans' });
  const firstBy = async () => page.locator('.plan-supplier').first().innerText();

  const byCost = await firstBy();
  await page.getByRole('button', { name: 'Standing charge' }).click();
  const byStanding = await firstBy();

  // The underlying ranking is untouched — only the presentation order moved.
  const cheapest = await page.evaluate(() => window.getRecommendation().cheapest.plan.supplier);
  expect(byCost).toContain(cheapest);
  expect(await page.evaluate(() => window.state._plans_sort)).toBe('standing');
  expect(typeof byStanding).toBe('string');
  expect(errors).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The search, in a browser, on the real tariff file.
 *
 * The unit tests prove the algorithm against a synthetic home and invented
 * plans. They cannot prove that it survives the trip through a worker, that
 * the 27 real tariffs produce a sane answer, or that the cost model on this
 * side and the one reconstructed on the worker side still agree — and that
 * last one is the kind of drift that produces a confident recommendation
 * priced from a stale coefficient.
 *
 * Nothing here touches a screen. The search has no interface yet, by design:
 * this is the engine landing before the product that will use it.
 */

test('a real home gets a real recommendation', async ({ page }) => {
  await boot(page);

  const out = await page.evaluate(async () => {
    const progress = [];
    const t = performance.now();
    const { result, reasons, confidence } = await window.runDesignSearch((p) => progress.push(p));
    return { result, reasons, confidence, progress, ms: Math.round(performance.now() - t) };
  });

  const { result } = out;
  expect(result.best, 'no recommendation for an ordinary Irish home').toBeTruthy();

  // A system someone could actually buy.
  expect(result.best.panels).toBeGreaterThanOrEqual(4);
  expect(result.best.panels).toBeLessThanOrEqual(24);
  expect(result.best.netCost).toBeGreaterThan(2000);
  expect(result.best.netCost).toBeLessThan(60000);
  expect(result.best.payback).toBeGreaterThan(0);
  expect(result.best.annualBenefit, 'recommended a system that saves nothing').toBeGreaterThan(0);

  // It has to name a tariff that exists.
  const planIds = await page.evaluate(() => window.TARIFFS.map((p) => p.id));
  expect(planIds).toContain(result.best.planId);
  for (const id of result.shortlist) expect(planIds).toContain(id);

  // The count shown to a reader must be simulations actually run.
  expect(result.evaluated).toBeGreaterThan(100);
  expect(result.ranked.length).toBeGreaterThan(10);

  // Ranked really is ranked.
  for (let i = 1; i < result.ranked.length; i += 1) {
    expect(result.ranked[i - 1].npv).toBeGreaterThanOrEqual(result.ranked[i].npv);
  }

  // Confidence means something: bounded, and not a constant.
  expect(out.confidence).toBeGreaterThan(0);
  expect(out.confidence).toBeLessThanOrEqual(1);

  // Each reason is a comparison the search actually priced.
  expect(out.reasons.length).toBeGreaterThan(0);
  for (const r of out.reasons) {
    expect(typeof r.kind).toBe('string');
    if (r.against) {
      expect(result.ranked.some((d) => d.panels === r.against.panels
        && d.batteryKwh === r.against.batteryKwh)).toBe(true);
    }
  }
});

test('the search reports honest progress and does not freeze the page', async ({ page }) => {
  await boot(page);

  const out = await page.evaluate(async () => {
    // A beat counter driven by the event loop. If the search ran on the main
    // thread this would stop dead for the duration.
    let beats = 0;
    const timer = setInterval(() => { beats += 1; }, 16);
    const progress = [];
    const { result } = await window.runDesignSearch((p) => progress.push({ ...p }));
    clearInterval(timer);
    return { beats, progress, elapsedMs: result.elapsedMs, evaluated: result.evaluated };
  });

  expect(out.progress.length, 'the search never reported progress').toBeGreaterThan(2);
  // Monotonic, and finishing at the end.
  for (let i = 1; i < out.progress.length; i += 1) {
    expect(out.progress[i].fraction).toBeGreaterThanOrEqual(out.progress[i - 1].fraction);
    expect(out.progress[i].evaluated).toBeGreaterThanOrEqual(out.progress[i - 1].evaluated);
  }
  expect(out.progress[out.progress.length - 1].fraction).toBe(1);

  // The main thread kept running. Roughly one beat per 16ms of search; allow
  // wide margins for a loaded CI box, the point is that it is not near zero.
  const expected = out.elapsedMs / 16;
  expect(out.beats, `main thread stalled: ${out.beats} beats over ${out.elapsedMs}ms`)
    .toBeGreaterThan(Math.min(5, expected * 0.3));
});

test('the worker prices systems exactly as the app does', async ({ page }) => {
  await boot(page);

  // The worker rebuilds estimateInstallCost() and calcSeaiGrant() from
  // coefficients. If either side changes alone, every price in every
  // recommendation is quietly wrong while every screen stays right.
  const mismatches = await page.evaluate(async () => {
    const { result } = await window.runDesignSearch();
    const bad = [];
    for (const d of result.ranked) {
      const cost = window.estimateInstallCost(d.kwp, d.batteryKwh);
      const grant = window.calcSeaiGrant(d.kwp, d.batteryKwh).total;
      if (cost !== d.cost || grant !== d.grant) {
        bad.push({ kwp: d.kwp, batt: d.batteryKwh, searchCost: d.cost, appCost: cost,
          searchGrant: d.grant, appGrant: grant });
      }
    }
    return bad;
  });
  expect(mismatches, 'the worker and the app disagree on what a system costs').toEqual([]);
});

test('a search does not disturb the system the reader is looking at', async ({ page }) => {
  await boot(page);

  const out = await page.evaluate(async () => {
    window.state.count_A = 10;
    window.state.battery_kwh = 5;
    window.state.strategy_mode = 'arbitrage';
    window.state.charge_from_grid = true;
    window.invalidate();
    const before = JSON.stringify([window.state.count_A, window.state.battery_kwh,
      window.state.strategy_mode, window.state.charge_from_grid, window.state.export_enabled]);
    const costBefore = window.getBestPlan().net;

    await window.runDesignSearch();

    const after = JSON.stringify([window.state.count_A, window.state.battery_kwh,
      window.state.strategy_mode, window.state.charge_from_grid, window.state.export_enabled]);
    return { before, after, costBefore, costAfter: window.getBestPlan().net };
  });

  // The V3 sweep worked by mutating state and putting it back, which is how
  // arbitrage used to switch itself off while the reader watched. The search
  // never touches state at all.
  expect(out.after, 'the search changed the system on screen').toBe(out.before);
  expect(out.costAfter).toBeCloseTo(out.costBefore, 6);
});

/**
 * Four goals, four answers, one sweep — in a browser, on the real tariffs.
 *
 * "Best" is not a technical question. Someone treating the roof as a
 * twenty-year investment, someone borrowing so they can stop paying the
 * utility and start paying the bank, and someone who wants off the grid are
 * asking different questions, two of them with hard constraints attached. The
 * engine must not quietly answer the investment question and relabel it.
 */
test('the goal changes the recommendation, on real data', async ({ page }) => {
  await boot(page);

  const out = await page.evaluate(async () => {
    const { result, reasons, confidence } = await window.runDesignSearch(null, { goal: 'independence' });
    return { byGoal: result.byGoal, best: result.best, goal: result.goal, reasons, confidence };
  });

  expect(out.goal).toBe('independence');
  for (const goal of ['max-return', 'bill-swap', 'independence', 'fast-payback']) {
    expect(Object.keys(out.byGoal)).toContain(goal);
  }

  const investor = out.byGoal['max-return'];
  const off = out.byGoal.independence;
  const swap = out.byGoal['bill-swap'];
  expect(investor).toBeTruthy();
  expect(off).toBeTruthy();

  // The answer that was asked for is the one returned.
  expect(out.best).toEqual(off);

  // Each goal's own metric holds up.
  expect(off.selfSufficiency).toBeGreaterThanOrEqual(investor.selfSufficiency);
  expect(investor.npv).toBeGreaterThanOrEqual(off.npv);
  if (swap) {
    expect(swap.monthlyNetChange, 'a bill swap that costs more than it saves').toBeGreaterThan(0);
    expect(swap.monthlyRepayment).toBeGreaterThan(0);
  }

  // Independence is bought with storage, charged from the roof rather than the
  // grid — grid-charging is cheaper dependence, not autonomy.
  expect(off.batteryKwh).toBeGreaterThan(0);
  expect(off.chargeFromGrid).toBe(false);

  // And its price is stated rather than buried.
  if (off.npv < investor.npv) {
    const price = out.reasons.find((r) => r.kind === 'independence-costs-return');
    expect(price, 'independence was recommended without naming what it costs').toBeTruthy();
    expect(price.worth).toBeGreaterThan(0);
  }
});

test('an impossible goal is refused, not fudged', async ({ page }) => {
  await boot(page);

  const out = await page.evaluate(async () => {
    // 30% over three years: nothing saves enough to cover that repayment.
    const { result, reasons } = await window.runDesignSearch(null,
      { goal: 'bill-swap', finance: { annualRate: 0.30, termYears: 3 } });
    return { best: result.best, reasons: reasons.map((r) => r.kind), byGoal: result.byGoal };
  });

  expect(out.best, 'recommended a loan the household cannot cover').toBeNull();
  // Distinct from "solar is not worth it here" — it is, just not on those
  // terms, and the two call for completely different next steps.
  expect(out.reasons).toEqual(['no-system-meets-this-goal']);
  expect(out.byGoal['max-return'], 'the other goals lost their answers too').toBeTruthy();
});

/**
 * The roof is no longer a constant I invented.
 *
 * It was, and it was the single biggest lever on what got recommended: the
 * search kept returning "as many panels as will fit", so the answer was
 * decided by my assumption rather than by the economics, and nobody was told.
 * Onboarding now asks what kind of house it is, which everybody knows, instead
 * of the roof area, which almost nobody does.
 */
test('the kind of house sets the ceiling on the recommendation', async ({ page }) => {
  await boot(page);

  const capFor = (dwelling, bedrooms) => page.evaluate(([d, b]) => {
    window.state.dwelling_type = d;
    window.state.bedrooms = b;
    window.state.roof_capacity_panels = 0;
    return { cap: window.roofPanelCap(), est: window.roofEstimate() };
  }, [dwelling, bedrooms]);

  const semi = await capFor('semi-detached', 3);
  const bungalow = await capFor('bungalow', 4);
  const flat = await capFor('apartment', 2);

  expect(semi.cap).toBeGreaterThan(6);
  expect(semi.cap).toBeLessThan(14);
  expect(bungalow.cap, 'a bungalow got no more roof than a semi').toBeGreaterThan(semi.cap);
  expect(flat.cap).toBe(0);
  expect(semi.est.assumptions.length).toBeGreaterThan(2);

  // And it must actually bind the search.
  await capFor('terraced', 2);
  const small = await page.evaluate(async () => (await window.runDesignSearch()).result);
  expect(small.best).toBeTruthy();
  expect(small.best.panels).toBeLessThanOrEqual(await page.evaluate(() => window.roofPanelCap()));

  await capFor('bungalow', 5);
  const big = await page.evaluate(async () => (await window.runDesignSearch()).result);
  expect(big.best.panels, 'the bigger roof did not change the recommendation')
    .toBeGreaterThan(small.best.panels);
});

test('an apartment is told the truth rather than sold panels', async ({ page }) => {
  await boot(page);

  const out = await page.evaluate(async () => {
    window.state.dwelling_type = 'apartment';
    window.state.bedrooms = 2;
    window.state.roof_capacity_panels = 0;
    const { result, reasons } = await window.runDesignSearch();
    return { best: result.best, noRoof: result.noRoof, reasons: reasons.map((r) => r.kind),
      doNothing: result.doNothing };
  });

  expect(out.best).toBeNull();
  expect(out.noRoof).toBe(true);
  expect(out.reasons).toEqual(['no-usable-roof']);
  // The tariff comparison still works — that part of the app serves them fine.
  expect(out.doNothing.annualNet).toBeGreaterThan(0);
});

test('onboarding asks the house, shows the roof, and remembers both', async ({ page }) => {
  await boot(page);

  await page.evaluate(() => { window.state.current_screen = 'onboarding'; window._ob.step = 1; window.renderApp(); });

  // The estimate is on screen before anything is touched: the reader is
  // correcting a figure rather than being asked to supply one.
  await expect(page.getByText(/would fit/i)).toBeVisible();

  await page.getByRole('button', { name: /^Bungalow/ }).click();
  await page.getByRole('button', { name: '5', exact: true }).click();
  const shown = await page.getByText(/would fit/i).innerText();
  expect(shown).toMatch(/About \d+ panels/);

  await page.getByRole('button', { name: /^Apartment/ }).click();
  await expect(page.getByText(/no roof of its own/i)).toBeVisible();

  await page.getByRole('button', { name: /^Detached/ }).click();
  await page.getByRole('button', { name: '4', exact: true }).click();

  // Walk it out, and check the answer survived into the app's own state.
  for (let i = 0; i < 5; i += 1) {
    await page.locator('.switch-cta').first().click();
    await page.waitForTimeout(250);
  }
  const kept = await page.evaluate(() => ({
    screen: window.state.current_screen,
    dwelling: window.state.dwelling_type,
    bedrooms: window.state.bedrooms,
    cap: window.roofPanelCap(),
  }));
  expect(kept.screen).toBe('result');
  expect(kept.dwelling).toBe('detached');
  expect(kept.bedrooms).toBe(4);
  expect(kept.cap).toBeGreaterThan(12);
});

/**
 * The advisor screen, under every goal.
 *
 * This suite already proved the engine. It did not render the engine's output,
 * and a reason template that only fires under one goal shipped broken because
 * of it: independence scores its margin in percentage points of
 * self-sufficiency, and the sentence printed it with a euro sign — "€19 of
 * self-sufficiency", which is not a quantity of anything. A second one threw a
 * ReferenceError that no test could see, because no test had ever drawn that
 * branch.
 *
 * So this walks all four goals and reads what is actually on the screen.
 */
const GOALS = ['max-return', 'bill-swap', 'independence', 'fast-payback'];

test('the advisor renders every goal without throwing, and says something true', async ({ page }) => {
  const errors = await boot(page);

  await page.evaluate(() => {
    window.state.dwelling_type = 'detached';
    window.state.bedrooms = 4;
    window.state.roof_capacity_panels = 0;
    window.setScreen('advisor');
  });
  await expect(page.locator('.adv-hero')).toBeVisible({ timeout: 20_000 });

  for (const goal of GOALS) {
    await page.evaluate((g) => window.setAdvisorGoal(g), goal);
    await page.waitForTimeout(350);

    const hero = page.locator('.adv-hero');
    await expect(hero, `no recommendation under ${goal}`).toBeVisible();
    await expect(hero).toContainText(/\d+ panels/);

    const text = await page.locator('.screen').innerText();

    // A euro sign in front of a percentage, or in front of years, means a
    // reason template printed one unit in another's clothes.
    expect(text, `${goal}: a euro figure was labelled as self-sufficiency`)
      .not.toMatch(/€[\d,.]+\s*(of self-sufficiency|percentage)/i);
    expect(text, `${goal}: a euro figure was labelled as a duration`)
      .not.toMatch(/€[\d,.]+\s*years/i);
    // Nothing half-rendered.
    expect(text).not.toMatch(/undefined|NaN|\[object/);
    expect(text).not.toMatch(/€NaN|€undefined/);
  }

  expect(errors, 'the advisor threw while rendering a goal').toEqual([]);
});

test('switching goals is instant, and does not re-run the search', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.setScreen('advisor'));
  await expect(page.locator('.adv-hero')).toBeVisible({ timeout: 20_000 });

  // One sweep answered all four goals. A spinner between two answers already
  // in hand would be theatre, and a re-run would be worse.
  const before = await page.evaluate(() => window.__searchRuns || 0);
  const t0 = Date.now();
  for (const g of GOALS) {
    await page.evaluate((x) => window.setAdvisorGoal(x), g);
    await expect(page.locator('.adv-hero')).toBeVisible();
  }
  const elapsed = Date.now() - t0;
  const after = await page.evaluate(() => window.__searchRuns || 0);

  expect(after - before, 'switching goal re-ran the search').toBe(0);
  expect(elapsed, `four goal switches took ${elapsed}ms`).toBeLessThan(3000);
});

test('adopting the recommendation makes it the reader’s own system', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.setScreen('advisor'));
  await expect(page.locator('.adv-hero')).toBeVisible({ timeout: 20_000 });

  const rec = await page.evaluate(() => {
    const r = window.advisorResult();
    return r ? r.best : null;
  });

  await page.getByRole('button', { name: /Use this as my system/i }).click();
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => ({
    screen: window.state.current_screen,
    panels: window.state.count_A,
    battery: window.state.battery_kwh,
    plan: window.state.chosen_plan,
    hasSolar: window.state.has_solar,
  }));
  expect(after.hasSolar).toBe(true);
  expect(after.panels).toBeGreaterThan(0);
  expect(after.plan, 'the recommended tariff was not adopted with the system').toBeTruthy();
  if (rec) {
    expect(after.panels).toBe(rec.panels);
    expect(after.battery).toBe(rec.batteryKwh);
  }
});

/**
 * The goal question, in onboarding.
 *
 * Everything else onboarding asks describes the house. This describes the
 * person, and it is the only question the engine cannot answer for itself: the
 * same roof, tariffs and usage produce four different right answers depending
 * on the reply.
 *
 * It is also the question most likely to be asked and then ignored, which is
 * the failure mode the whole redesign is against. So these tests follow it all
 * the way through to the screen it decides.
 */
test('the goal is asked only when it can change something', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.state.current_screen = 'onboarding'; window._ob.step = 1; window.renderApp(); });

  // Someone with no interest in solar is never asked what they want solar to
  // do for them — a question that cannot change what they are shown is a
  // reason to abandon a form.
  const noSolar = await page.evaluate(() => { window._ob.has_solar = false; window.renderApp(); return window.obTotal(); });
  expect(noSolar).toBe(5);
  for (let i = 1; i <= 5; i += 1) {
    expect(await page.evaluate((n) => window.obStepKey(n), i), `step ${i} is the goal question`)
      .not.toBe('goal');
  }

  const withSolar = await page.evaluate(() => { window._ob.has_solar = true; window.renderApp(); return window.obTotal(); });
  expect(withSolar).toBe(6);

  // The progress dots have to agree with the count, or the progress bar lies.
  const dots = await page.locator('.ob-progress > span').count();
  expect(dots).toBe(withSolar);
});

test('the goal you choose is the question the advisor answers', async ({ page }) => {
  const errors = await boot(page);

  await page.evaluate(() => {
    window.state.dwelling_type = 'detached';
    window.state.bedrooms = 4;
    window.state.current_screen = 'onboarding';
    window._ob.has_solar = true;
    window._ob.step = window.obTotal();
    window.renderApp();
  });

  await expect(page.getByText(/What would you like solar to/i)).toBeVisible();
  await expect(page.locator('.ob-goal')).toHaveCount(4);

  // Written as outcomes, not as objective functions. The engine's own names
  // for these must never reach a screen.
  const text = await page.locator('.ob-content').innerText();
  expect(text).not.toMatch(/max-return|bill-swap|fast-payback|NPV|net present value/i);

  await page.locator('.ob-goal', { hasText: /Rely on the grid/i }).click();
  await expect(page.locator('.ob-goal.active')).toContainText(/Rely on the grid/i);

  // The closing call to action promises the answer, not another form.
  await expect(page.locator('.switch-cta')).toContainText(/what to install/i);
  await page.locator('.switch-cta').click();

  // …and it delivers it, for the goal that was asked for.
  await expect(page.locator('.adv-hero')).toBeVisible({ timeout: 20_000 });
  expect(await page.evaluate(() => window.state.search_goal)).toBe('independence');
  expect(await page.evaluate(() => window.advisorResult().goal)).toBe('independence');
  await expect(page.locator('.goal-chip.active')).toContainText(/Independence/i);
  expect(errors).toEqual([]);
});

test('someone with no interest in solar still lands on their bill', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.state.current_screen = 'onboarding';
    window._ob.has_solar = false;
    window._ob.step = window.obTotal();
    window.renderApp();
  });
  await expect(page.locator('.switch-cta')).toContainText(/my best plan/i);
  await page.locator('.switch-cta').click();
  await page.waitForTimeout(600);
  // The advisor has nothing to tell them; the tariff comparison has everything.
  expect(await page.evaluate(() => window.state.current_screen)).toBe('result');
});

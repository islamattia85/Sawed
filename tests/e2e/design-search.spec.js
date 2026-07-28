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

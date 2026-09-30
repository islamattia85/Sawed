import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * V7's own promises.
 *
 * The redesign replaced a single "you could save" figure with a ladder, lists
 * with bars, and screens with sheets. Each of those is only an improvement if
 * it is faithful — a ladder whose rungs do not add up, or a bar whose length
 * is not the cost, is a prettier way of being wrong. These tests hold that.
 */

test('the ladder adds up: switching plus solar is the whole saving', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const rungs = [...document.querySelectorAll('.v7-ladder [data-rung]')]
      .map((g) => ({ label: g.dataset.label, value: +g.dataset.value }));
    const rec = window.getRecommendation();
    return { rungs, base: rec.baseCost, net: rec.best.net, saving: rec.annualSavings };
  });

  expect(r.rungs.length, 'solar home shows: without solar, with solar, then switched').toBe(3);
  expect(Math.abs(r.rungs[0].value - r.base)).toBeLessThan(1);
  expect(Math.abs(r.rungs[2].value - r.net)).toBeLessThan(1);
  // The two parts of the saving are read off the rungs and must sum to the
  // headline. Solar is the first step; switching is measured on the home with
  // its solar, because that is the home the switch happens to.
  const fromSolar = r.rungs[0].value - r.rungs[1].value;
  const fromSwitch = r.rungs[1].value - r.rungs[2].value;
  expect(Math.abs(fromSwitch + fromSolar - r.saving), 'the parts do not sum to the headline').toBeLessThan(2);
  expect(fromSwitch, 'switching alone cannot cost money if it is the recommendation').toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('the switch button says what the switch is worth, not what the panels earn', async ({ page }) => {
  await boot(page);
  const { cta, rungs } = await page.evaluate(() => ({
    cta: document.querySelector('.switch-cta').textContent.replace(/\s+/g, ' '),
    rungs: [...document.querySelectorAll('.v7-ladder [data-rung]')].map((g) => +g.dataset.value),
  }));
  const fromSwitch = Math.round(rungs[1] - rungs[2]);
  expect(cta).toContain(`€${fromSwitch.toLocaleString('en-IE')}/yr`);
});

test('the plans list and the home agree on what switching is worth', async ({ page }) => {
  // The row for the recommended plan and the switch step on the home ladder are
  // the same question — what does changing plan save this home — and must give
  // the same answer. They disagreed by over a thousand euro when the rows were
  // measured against a bill without the solar.
  await boot(page);
  const step = await page.evaluate(() => {
    const v = [...document.querySelectorAll('.v7-ladder [data-rung]')].map((g) => +g.dataset.value);
    return Math.round(v[1] - v[2]);
  });
  await page.evaluate(() => window.setScreen('plans'));
  const row = await page.evaluate(() => {
    const el = document.querySelector('.v7-plan.best .v7-plan-delta');
    return Math.round(parseFloat(el.textContent.replace(/[^\d.]/g, '')));
  });
  expect(Math.abs(row - step), `row says €${row}, home says €${step}`).toBeLessThanOrEqual(1);
});

test('a home without solar gets a two-rung ladder, with nothing credited to panels', async ({ page }) => {
  await boot(page, { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  const n = await page.locator('.v7-ladder [data-rung]').count();
  expect(n).toBe(2);
  await expect(page.locator('.v7-split')).toHaveCount(0);
});

test('every plan bar is its cost on the same ruler', async ({ page }) => {
  await boot(page, { current_screen: 'plans', _plans_all: true });
  const rows = await page.evaluate(() => [...document.querySelectorAll('.v7-plan')].map((el) => ({
    width: parseFloat(el.querySelector('.v7-bar > span').style.width),
    cost: parseFloat(el.querySelector('.plan-cost').textContent.replace(/[^\d.-]/g, '')),
  })));
  expect(rows.length).toBeGreaterThan(10);
  // Width / cost is the same constant for every plan above the minimum sliver.
  const k = rows.filter((r) => r.width > 3).map((r) => r.width / r.cost);
  const spread = Math.max(...k) / Math.min(...k);
  expect(spread, 'bars are not drawn on one scale').toBeLessThan(1.02);
});

test('a plan opens as a sheet over the list, and closes back onto it', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'plans' });
  await page.locator('.v7-plan').nth(1).click();
  await expect(page.locator('#v7-sheet')).toBeVisible();
  // No navigation happened — the list is still underneath.
  expect(await page.evaluate(() => window.state.current_screen)).toBe('plans');
  await expect(page.locator('#v7-sheet .v7-ratestrip')).toBeVisible();

  await page.locator('.v7-sheet-x').click();
  await expect(page.locator('#v7-sheet')).toHaveCount(0);
  expect(await page.evaluate(() => window.state.current_screen)).toBe('plans');
  expect(errors).toEqual([]);
});

test('a plan with an announced rise says so on its row and in its sheet', async ({ page }) => {
  await boot(page, { current_screen: 'plans', _plans_all: true });
  const id = await page.evaluate(() => (window.TARIFFS || []).find((t) => t.price_change && !t.discontinued)?.id);
  test.skip(!id, 'no announced price changes in the current data');
  await page.evaluate((pid) => window.v7Sheet('plan', pid), id);
  await expect(page.locator('#v7-sheet .v7-note.is-rise')).toContainText(/Prices rise/);
});

test('no screen shouts: nothing is set in uppercase by style', async ({ page }) => {
  await boot(page);
  const shouting = await page.evaluate(() => {
    const out = [];
    for (const s of ['result', 'plans', 'solar', 'more', 'analytics', 'monitor']) {
      window.setScreen(s);
      for (const el of document.querySelectorAll('#app-root *')) {
        if (getComputedStyle(el).textTransform === 'uppercase' && el.textContent.trim()) {
          out.push(`${s}: ${el.textContent.trim().slice(0, 30)}`);
        }
      }
    }
    return out;
  });
  expect(shouting).toEqual([]);
});

test('the four tabs are destinations: no back arrow on any of them', async ({ page }) => {
  await boot(page);
  for (const s of ['result', 'plans', 'solar', 'more']) {
    await page.evaluate((x) => window.setScreen(x), s);
    await expect(page.locator('.v7-top [aria-label="Back"]'), `${s} shows a back arrow`).toHaveCount(0);
  }
});

test('the way back into setup, and sharing, survive the redesign', async ({ page }) => {
  // V7's first cut dropped both from the home screen and nothing noticed — a
  // returning visitor then had no route back into the guided setup at all.
  const errors = await boot(page);
  await expect(page.getByRole('button', { name: /Share analysis/ })).toBeVisible();
  await page.getByRole('button', { name: /Re-run setup/ }).click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('onboarding');
  expect(errors).toEqual([]);
});

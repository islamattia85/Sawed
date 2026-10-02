import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * One house, compared against itself.
 *
 * The old "Solar impact" card read the current-plan figure from baselineSim(),
 * which answers a different question: "what does your bill say today?" For
 * someone planning an EV that deliberately excludes the car, while the rows
 * beneath it included it. So the card compared a house without a car against a
 * house with one, and showed a "best plan" costing €267 more than the plan the
 * user was already on. A user caught it at once: "how can a best plan with no
 * solar differ than current plan and be more expensive?"
 *
 * v8 retired the card: its three rows are Home's staircase, and the switch it
 * priced is the Bill tab's "cheapest plan" card. The properties it guarded
 * move with them.
 */

const EV_PLANNER = {
  current_screen: 'analytics', _an_tab: 'bill', has_solar: true, considering_solar: true,
  count_A: 30, battery_kwh: 10, baseline: 'BG-24', baseline_known: true,
  // The case that broke: a car being planned for, not yet on the bill.
  ev_active: true, ev_in_bill: false, ev_km_per_year: 15000,
};

/** The Bill tab's figures: what you pay, and the cheapest plan's year if one is shown. */
async function bill(page) {
  return page.evaluate(() => {
    const big = document.querySelector('.ax-ans .ax-big');
    const euros = (t) => Number((t.match(/€([\d,]+)/) || [0, '0'])[1].replace(/,/g, ''));
    const cards = [...document.querySelectorAll('.ax-card')];
    const cheap = cards.find((c) => /cheapest|less a year|beats your plan|much less/i.test(c.querySelector('.ax-t').textContent));
    const bars = cheap ? [...cheap.querySelectorAll('.ax-hbar b')].map((b) => euros(b.textContent)) : [];
    return { today: euros(big.textContent), bars, title: cheap ? cheap.querySelector('.ax-t').textContent : null };
  });
}

test('switching never costs more than staying, for a driver planning an EV', async ({ page }) => {
  const errors = await boot(page, EV_PLANNER);
  const b = await bill(page);
  expect(b.title, 'the cheapest-plan card did not render').not.toBeNull();
  if (b.bars.length === 2) {
    expect(b.bars[0], 'the "you now" bar is not what you pay').toBe(b.today);
    expect(b.bars[1], `"${b.title}" — a cheapest plan cannot lose to the one you are on`).toBeLessThanOrEqual(b.bars[0]);
  }
  expect(errors).toEqual([]);
});

test('the same house is priced on both sides of the comparison', async ({ page }) => {
  await boot(page, EV_PLANNER);
  // Pin the mechanism: what you pay must move when the EV load moves.
  const withEv = (await bill(page)).today;
  await page.evaluate(() => { window.state.ev_active = false; window.invalidate(); window.renderApp(); });
  const withoutEv = (await bill(page)).today;
  expect(withEv, 'what you pay ignored the EV that the cheapest plan was priced with').toBeGreaterThan(withoutEv);
});

test('a plan that beats everything on sale says why instead of looking like a bug', async ({ page }) => {
  await boot(page, EV_PLANNER);
  const b = await bill(page);
  // Staying put can legitimately win on a withdrawn rate. Whenever it does,
  // the card says so rather than showing a "cheaper" plan that costs more.
  if (b.bars.length === 2 && b.bars[1] > b.bars[0]) throw new Error('a dearer plan is shown as the cheaper one');
  if (/beats your plan/.test(b.title)) await expect(page.locator('.ax-card', { hasText: 'beats your plan' })).toContainText('keep it while you can');
});

test('every figure names the same choices, not two different "best" plans', async ({ page }) => {
  await boot(page, { ...EV_PLANNER, current_screen: 'result', solar_planned: true });
  const labels = await page.evaluate(() => [...document.querySelectorAll('.v7-hero .v7-ladder [data-rung]')]
    .map((r) => r.dataset.label));
  expect(labels.length, 'the staircase did not render').toBe(4);
  // Two rows both labelled "Best plan" invited exactly the question the user
  // asked: how can they both be best?
  expect(labels.filter((l) => /Best plan/i.test(l)), 'a row still claims to be the best plan').toHaveLength(0);
  expect(labels[0]).toMatch(/^Now, /);
});

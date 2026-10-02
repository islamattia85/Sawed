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

/** The Bill tab: what this home pays on its plan, and the bars it is compared with. */
async function bill(page) {
  return page.evaluate(() => {
    const big = document.querySelector('.ax-ans .ax-big');
    const euros = (t) => Number((t.match(/€([\d,]+)/) || [0, '0'])[1].replace(/,/g, ''));
    const card = [...document.querySelectorAll('.ax-card')].find((c) => /pay now/i.test(c.querySelector('.ax-t').textContent));
    const bars = card ? [...card.querySelectorAll('.ax-hbar b')].map((b) => euros(b.textContent)) : [];
    return { home: euros(big.textContent), bars, title: card ? card.querySelector('.ax-t').textContent : null };
  });
}

test('switching never costs more than staying, for a driver planning an EV', async ({ page }) => {
  const errors = await boot(page, EV_PLANNER);
  const b = await bill(page);
  expect(b.title, 'the comparison with now did not render').not.toBeNull();
  expect(b.bars[1], 'the "this home" bar is not what this home pays').toBe(b.home);
  expect(b.bars[1], `"${b.title}": the best plan cannot lose to the one you are on`).toBeLessThanOrEqual(b.bars[0]);
  expect(errors).toEqual([]);
});

test('the same house is priced on both sides of the comparison', async ({ page }) => {
  await boot(page, EV_PLANNER);
  // Pin the mechanism: "now" must move when the EV load moves.
  const withEv = (await bill(page)).bars[0];
  await page.evaluate(() => { window.state.ev_active = false; window.invalidate(); window.renderApp(); });
  const withoutEv = (await bill(page)).bars[0];
  expect(withEv, '"now" ignored the EV that this home was priced with').toBeGreaterThan(withoutEv);
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

import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The "Solar impact" card compares one house against itself.
 *
 * It used to read the current-plan figure from baselineSim(), which answers a
 * different question: "what does your bill say today?" For someone planning an
 * EV that deliberately excludes the car, because the car is not in the bill
 * yet — while the two rows beneath it, being forward-looking scenarios, both
 * included it. So the card compared a house without a car against a house with
 * one, and displayed a "best plan" costing €267 more than the plan the user was
 * already on.
 *
 * A user caught it immediately: "how can a best plan with no solar differ than
 * current plan and be more expensive?" It cannot, and no amount of correct
 * arithmetic elsewhere survives a reader seeing that.
 */

const EV_PLANNER = {
  current_screen: 'solar', has_solar: true, considering_solar: true,
  count_A: 30, battery_kwh: 10, baseline: 'BG-24', baseline_known: true,
  // The case that broke: a car being planned for, not yet on the bill.
  ev_active: true, ev_in_bill: false, ev_km_per_year: 15000,
};

/**
 * The three euro figures in the card, top to bottom.
 *
 * The card moved behind "Show me the working" when the solar screen was cut
 * from 4.2 phone-screens to 2.9 — it is instrumentation, not advice. The
 * property it guards is unchanged and still load-bearing, so these tests open
 * the door rather than assert the card is on the surface.
 */
async function rows(page) {
  const toggle = page.locator('.working-toggle');
  if (await toggle.count() && await toggle.getAttribute('aria-expanded') === 'false') {
    await toggle.click();
  }
  return page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')]
      .find((c) => /Solar impact/i.test(c.textContent));
    if (!card) return null;
    return [...card.querySelectorAll(':scope > div > div')]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => /€/.test(t))
      .map((t) => {
        const m = t.match(/(-?)€([\d,]+)/);
        return { label: t, value: (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, '')) };
      });
  });
}

test('switching never costs more than staying, for a driver planning an EV', async ({ page }) => {
  const errors = await boot(page, EV_PLANNER);
  const r = await rows(page);
  expect(r, 'the comparison card did not render').not.toBeNull();
  expect(r.length).toBe(3);

  const [stay, switchNoSolar, switchSolar] = r;
  expect(switchNoSolar.value,
    `"${switchNoSolar.label}" costs more than "${stay.label}" — a best plan cannot lose to the one you are on`)
    .toBeLessThanOrEqual(stay.value);
  expect(switchSolar.value, 'adding solar made the bill go up')
    .toBeLessThanOrEqual(switchNoSolar.value);

  expect(errors).toEqual([]);
});

test('the same house is priced in all three rows', async ({ page }) => {
  await boot(page, EV_PLANNER);

  // The bug was invisible in the totals alone — it showed up as the current
  // plan being cheap for a reason nothing on screen explained. Pin the actual
  // mechanism: the current-plan row must move when the EV load moves.
  const withEv = (await rows(page))[0].value;
  await page.evaluate(() => { window.state.ev_active = false; window.invalidate(); window.renderApp(); });
  const withoutEv = (await rows(page))[0].value;

  expect(withEv, 'the current-plan row ignored the EV that the rows below it included')
    .toBeGreaterThan(withoutEv);
});

test('a row that beats every switch says why instead of looking like a bug', async ({ page }) => {
  await boot(page, EV_PLANNER);
  await rows(page);          // opens the working, where the card now lives

  const explained = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card')]
      .find((c) => /Solar impact/i.test(c.textContent));
    const text = card.textContent;
    const rowValues = [...card.querySelectorAll(':scope > div > div')]
      .map((r) => r.textContent).filter((t) => /€/.test(t))
      .map((t) => { const m = t.match(/(-?)€([\d,]+)/); return (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, '')); });
    const stayingWins = rowValues[1] > rowValues[0] + 1;
    return { stayingWins, saysSo: /beats anything on sale today/.test(text) };
  });

  // Staying put can legitimately win on a withdrawn legacy rate. Whenever it
  // does, the card has to account for it — otherwise it reads as the same
  // contradiction all over again.
  if (explained.stayingWins) expect(explained.saysSo).toBe(true);
});

test('every figure names the same three choices, not two different "best" plans', async ({ page }) => {
  await boot(page, EV_PLANNER);
  const labels = (await rows(page)).map((r) => r.label);

  // Two rows both labelled "Best plan" invited exactly the question the user
  // asked: how can they both be best?
  const bests = labels.filter((l) => /^Best plan/i.test(l));
  expect(bests, 'more than one row still claims to be the best plan').toHaveLength(0);
  expect(labels[0]).toMatch(/Stay as you are/i);
});

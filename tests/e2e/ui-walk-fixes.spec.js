// @ts-check
/**
 * What a walk through the app on a home its plans pay found (10 Oct 2026): a
 * heat pump home with 10 panels and a 9 kWh battery, paid €141 a year on
 * Energia's EV plan and €220 on the best one. Here with 16 panels, so its
 * export pay passes the €600 a year that is tax-free.
 *
 * - Credits read as "−€218 a year" in sentences and lists ("this plan is still
 *   the best, at −€218 a year"), and both bars comparing two credits were empty.
 * - The breakdowns left out the tax on export income: €125 + €290 − €650 is
 *   −€235, not the −€220 the same card gave.
 * - The plan sheet said "#1 of 33" under a Plans page of 35.
 * - A home with its panels up was asked "Would solar pay off here?".
 */
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const PAID = { has_solar: true, solar_planned: false, considering_solar: false, count_A: 16, count_B: 0, panel_w: 460, azimuth_A: 180, tilt_A: 35,
  battery_kwh: 9, heating_type: 'heatpump', region: 'south', baseline: 'EN-EV', baseline_known: true, bimonthly_bill_eur: 140, usage_input_mode: 'bill',
  grid_charge_now: 'yes', bill_when: 'before', cost_is_manual: true, install_cost: 9800, grant_eligible: false, current_screen: 'result' };
const euros = (t) => { const m = String(t).match(/(paid\s*|[−-]?)€([\d,]+)/); return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, '')) : NaN; };

test('a home its plans pay: credits are said in words, drawn as bars, and the breakdowns add up', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await boot(page, PAID, '/');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.setScreen('result'));
  const best = await page.evaluate(() => window.getRecommendation().best.net);
  expect(best, 'this home is paid on its best plan').toBeLessThan(-50);

  // Home: no minus sign before a euro in a sentence; the bars have length.
  const text = await page.locator('body').innerText();
  expect(text, 'a credit in words, not "−€"').not.toMatch(/(at|On [^:]*:) −€/);
  const widths = await page.locator('.lad-row .lad-t > i').evaluateAll((els) => els.map((e) => parseFloat(e.style.width)));
  expect(widths.length).toBeGreaterThanOrEqual(2);
  for (const w of widths) expect(w, `bar widths ${widths}`).toBeGreaterThan(20);

  // The website's breakdown: bought less paid back plus the tax is the year.
  const lines = await page.locator('.wd-split > div').allInnerTexts();
  const sum = lines.reduce((a, l) => a + euros(l.split('\n').pop()), 0);
  expect(lines.some((l) => /^Tax on what you sell/.test(l)), lines.join(' | ')).toBe(true);
  expect(Math.abs(sum - best), `${lines.join(' | ')} = ${sum}, the year is ${best}`).toBeLessThanOrEqual(lines.length);
  // Top plans: paid, not minus.
  await expect(page.locator('.wd-plans').first()).toContainText('paid €');

  // One count of plans: the Plans page's.
  const top = await page.locator('.wd-card', { hasText: 'Top plans for you' }).locator('.wd-link').innerText();
  await page.evaluate(() => window.setScreen('plans'));
  const all = Number(await page.locator('.plans-filters .count').first().innerText());
  expect(top, 'Home’s Top plans links to as many as Plans lists').toContain(`All ${all}`);
  await page.evaluate((id) => window.v7Sheet('plan', id), await page.evaluate(() => window.getRecommendation().best.plan.id));
  // (On a wide screen it opens beside the list, not over it.)
  await expect(page.getByText(/^#1 of \d+ for your home$/).first()).toHaveText(`#1 of ${all} for your home`);
  await page.evaluate(() => { window.state._sheet = null; window.renderApp(); });

  // The Bill tab: the parts, the sell-back and the tax add up to the year; credits as "paid".
  await page.evaluate(() => window.anTab('bill'));
  const card = page.locator('.ax-card').first();
  const parts = await card.locator('.ax-row:not(.ax-row-credit) .ax-row-v b').allTextContents();
  const credit = await card.locator('.ax-row-credit .ax-row-v b').allTextContents();
  const total = await page.evaluate(() => window.getRecommendation().best.net);
  const tally = parts.reduce((a, t) => a + euros(t), 0) - credit.reduce((a, t) => a + Math.abs(euros(t)), 0);
  expect(Math.abs(tally - total), `${parts} − ${credit} = ${tally}, the year is ${total}`).toBeLessThanOrEqual(parts.length + 1);
  const bars = await page.locator('.ax-hbar b').allTextContents();
  for (const b of bars) expect(b, bars.join(' | ')).toMatch(/^paid €/);

  // Solar, for panels already up.
  await page.evaluate(() => window.anTab('solar'));
  await expect(page.locator('.web-title').first()).toHaveText('Are your panels paying off?');
  expect(errors).toEqual([]);
});

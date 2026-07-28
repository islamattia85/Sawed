import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The quote auditor told people a good quote was a bad one.
 *
 * Its payback and twenty-year NPV were computed from `getBestPlan().savings`
 * — the saving from switching TARIFF on whatever system the reader already
 * had. For the overwhelmingly common case, someone with no solar collecting
 * quotes, that is the saving from changing supplier and has nothing whatever
 * to do with the panels being quoted.
 *
 * A €12,000 quote on a real Irish home was credited with €517 a year, and the
 * screen reported a 19.7-year payback and a NPV of −€4,168. Simulated
 * properly, the same system returns €1,362 a year, pays back in 7.5 years and
 * is worth +€7,991. The sign was wrong, not merely the magnitude: the app was
 * advising people out of a decision that was good for them.
 *
 * Nothing tested this screen's arithmetic. These tests do.
 */

const HOUSE = {
  onboarding_complete: true, seen_intro: true, current_screen: 'result',
  bimonthly_bill_eur: 320, heating_type: 'heatpump', region: 'south',
  baseline: 'EI-24', baseline_known: true, panel_w: 440,
  has_solar: false, considering_solar: true, ev_active: true,
};

async function audit(page, price, panels, battery) {
  await page.evaluate(() => window.setScreen('auditor'));
  await page.fill('#aud-price', String(price));
  await page.fill('#aud-panels', String(panels));
  await page.fill('#aud-battery', String(battery));
  await page.click('.aud-btn');
  await expect(page.locator('#audit-result')).not.toBeEmpty();
  return page.evaluate(() => document.getElementById('audit-result').innerText);
}

test.beforeEach(async ({ page }) => {
  await boot(page, HOUSE);
});

test('a quote is judged on what the quoted system saves, not on a tariff switch', async ({ page }) => {
  const text = await audit(page, 12000, 12, 5);

  const benefit = Number((text.match(/€([\d,]+)\/yr benefit/) || [])[1]?.replace(/,/g, ''));
  const payback = Number((text.match(/PAYBACK[^\n]*\n([\d.]+) yr/) || [])[1]);

  // A 5.3 kWp system with storage on a heat-pump home with an EV saves well
  // over a thousand a year. Anything near €500 is the tariff-switch figure
  // wearing the panels' clothes.
  expect(benefit, 'the benefit is a tariff saving, not a solar saving').toBeGreaterThan(900);
  expect(payback, 'payback is being computed from the wrong benefit').toBeLessThan(12);
  expect(payback).toBeGreaterThan(3);

  // And the twenty-year verdict must not be negative for an ordinary quote.
  expect(text, 'an ordinary quote is reported as a lifetime loss').not.toMatch(/-€[\d,]+\s*\n\s*Lifetime/);
});

test('a bigger system saves more, and a dearer one takes longer to repay', async ({ page }) => {
  const parse = (t) => ({
    benefit: Number((t.match(/€([\d,]+)\/yr benefit/) || [])[1]?.replace(/,/g, '')),
    payback: Number((t.match(/PAYBACK[^\n]*\n([\d.]+) yr/) || [])[1]),
  });

  const small = parse(await audit(page, 8000, 10, 0));
  const big = parse(await audit(page, 22000, 16, 10));

  // These are the two directions that prove the figure tracks the system
  // rather than the household: more kit saves more, and paying more for it
  // takes longer to get back.
  expect(big.benefit).toBeGreaterThan(small.benefit);
  expect(big.payback).toBeGreaterThan(small.payback);
});

test('auditing a quote does not change the system the reader owns', async ({ page }) => {
  const before = await page.evaluate(() => JSON.stringify([
    window.state.has_solar, window.state.count_A, window.state.count_B,
    window.state.battery_kwh, window.state.install_cost, window.state.grant_seai,
  ]));

  await audit(page, 12000, 12, 5);

  const after = await page.evaluate(() => JSON.stringify([
    window.state.has_solar, window.state.count_A, window.state.count_B,
    window.state.battery_kwh, window.state.install_cost, window.state.grant_seai,
  ]));

  // The benefit is measured by simulating the quoted system and then putting
  // everything back. If the restore ever slips, a reader's own configuration
  // silently becomes the installer's proposal.
  expect(after, 'the audit left the installer’s system in place').toBe(before);
});

test('the price verdict still reads the market, not the payback', async ({ page }) => {
  // The two halves are independent on purpose: a fairly-priced system can be
  // the wrong system, and an over-priced one can still pay back. Fixing the
  // payback must not have disturbed the price benchmark.
  const dear = await audit(page, 22000, 12, 5);
  expect(dear).toMatch(/Over-Market|Premium/i);

  const fair = await audit(page, 9000, 12, 5);
  expect(fair).toMatch(/Fair Market Value|Excellent/i);
});

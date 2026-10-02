import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Analytics: a tab per question.
 *
 * The single page these tabs replaced ran to eight phone screens, carried two
 * day inspectors and the monthly chart twice, and repeated Home's comparison.
 * Each tab now asks one question, answers it with one figure and folds its
 * detail. These tests hold that shape, and hold every figure to the one the
 * rest of the app shows for the same thing.
 */

const PLANNED = { has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 9 };
const euros = (t) => Number((String(t).match(/€([\d,]+)/) || [0, '0'])[1].replace(/,/g, ''));

test('the Bill tab prices the same home as Home’s staircase', async ({ page }) => {
  const errors = await boot(page, { ...PLANNED, current_screen: 'result' });
  const rungs = await page.evaluate(() => [...document.querySelectorAll('.v7-hero .v7-ladder [data-rung]')]
    .map((r) => Math.round(+r.dataset.value)));
  await page.locator('.ax-door', { hasText: 'Bill' }).click();
  // The simulated home (planned panels in) on its best plan is Home's last step,
  // and "now, as billed" is Home's first.
  await expect(page.locator('.ax-ans-k')).toHaveText('This home, with the planned panels, pays');
  expect(euros(await page.locator('.ax-ans .ax-big').textContent())).toBe(rungs[3]);
  const bars = await page.locator('.ax-hbar b').allTextContents();
  expect(euros(bars[0])).toBe(rungs[0]);
  // The parts add up to the year, to the euro (each part is rounded once).
  const card = page.locator('.ax-card').first();
  const parts = await card.locator('.ax-row:not(.ax-row-credit) .ax-row-v b').allTextContents();
  const credit = await card.locator('.ax-row-credit .ax-row-v b').allTextContents();
  const total = euros(await page.locator('.ax-ans .ax-big').textContent());
  const sum = parts.reduce((a, t) => a + euros(t), 0) - credit.reduce((a, t) => a + euros(t), 0);
  expect(Math.abs(sum - total)).toBeLessThanOrEqual(parts.length + 1);
  expect(errors).toEqual([]);
});

test('the Car tab is there only for a home with a car', async ({ page }) => {
  await boot(page, { current_screen: 'analytics', ev_active: false });
  await expect(page.locator('.ax-tab', { hasText: 'Car' })).toHaveCount(0);
  // Asked for anyway, it falls back to the Bill rather than a blank page.
  await page.evaluate(() => window.anTab('car'));
  await expect(page.locator('h1.ax-h')).toHaveText('Where does your money go?');

  // With one, Home's car card opens it, and both say the same yearly cost.
  await boot(page, { current_screen: 'result', ev_active: true, ev_in_bill: true, ev_km_per_year: 16000 });
  const row = page.locator('.v7-ev-ctl');
  const onHome = euros(await row.locator('small').textContent());
  await page.getByRole('button', { name: /Car analysis/ }).click();
  await expect(page.locator('.ax-tab.on')).toHaveText('Car');
  await expect(page.locator('.ax-ans-k')).toHaveText('To charge it');
  expect(euros(await page.locator('.ax-ans .ax-big').textContent())).toBe(onHome);
});

test('Hours: any day of the year, by chip, by date, or straight to the dearest', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'analytics', _an_tab: 'hours', _an_day: 10 });
  await page.locator('.ax-chip', { hasText: '21 June' }).click();
  await expect(page.locator('.ax-fact')).toContainText('21 June');
  expect(await page.evaluate(() => window.state._an_day)).toBe(171);
  // The dearest day is a link to itself.
  await page.locator('.ax-note .ax-inline').first().click();
  const dearest = await page.locator('.ax-note .ax-inline').first().textContent();
  await expect(page.locator('.ax-fact')).toContainText(dearest.split(',')[0]);
  // The hour-by-hour detail is folded, and opens in place.
  await expect(page.locator('.ax-day')).toHaveCount(0);
  await page.locator('.ax-more', { hasText: 'Every hour of' }).click();
  await expect(page.locator('.ax-day')).toContainText('What each hour cost');
  expect(errors).toEqual([]);
});

test('Accuracy: the ± figure is the parts combined, and says what would sharpen it', async ({ page }) => {
  await boot(page, { ...PLANNED, current_screen: 'analytics', _an_tab: 'accuracy' });
  const { pct, parts } = await page.evaluate(() => window.modelAccuracy());
  await expect(page.locator('.ax-ans .ax-big')).toContainText(`±${pct}%`);
  await expect(page.locator('.ax-acc .ax-acc-err:not(:empty)')).toHaveText(parts.slice().sort((a, b) => b.err - a.err).map((p) => `±${p.err}%`));
  // Without meter data, it says what the meter file would bring it to.
  await expect(page.locator('.ax-ans .ax-line')).toContainText(/Your meter file would bring it to ±\d+%/);
  await expect(page.getByRole('button', { name: /Upload your ESB meter file/ })).toBeVisible();
});

test('Solar: poor and good years arrive after the paint, and qualify the answer', async ({ page }) => {
  const errors = await boot(page, { ...PLANNED, current_screen: 'solar' });
  await expect(page.locator('.ax-wx-b[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
  const tiles = await page.locator('.ax-wx-b b').allTextContents();
  const yrs = tiles.map((t) => parseFloat(t));
  expect(yrs[0], 'a poor year paid back sooner than a typical one').toBeGreaterThanOrEqual(yrs[1]);
  expect(yrs[2], 'a good year paid back later than a typical one').toBeLessThanOrEqual(yrs[1]);
  // Tapping one makes it the answer.
  await page.locator('.ax-wx-b', { hasText: 'Poor year' }).click();
  await expect(page.locator('.ax-ans .qr-value')).toContainText(tiles[0].replace(' yrs', ''));
  await page.locator('.ax-wx-b', { hasText: 'Typical' }).click();
  expect(errors).toEqual([]);
});

test('every tab answers in about two screens, with its detail folded', async ({ page }) => {
  await boot(page, { ...PLANNED, ev_active: true, ev_in_bill: true, ev_km_per_year: 16000, current_screen: 'analytics' });
  const vh = await page.evaluate(() => window.innerHeight);
  for (const tab of ['bill', 'hours', 'solar', 'car', 'accuracy']) {
    await page.evaluate((t) => window.anTab(t), tab);
    await expect(page.locator('.screen')).toHaveAttribute('data-tab', tab);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    // The page it replaced was eight screens.
    expect(h / vh, `${tab} is ${(h / vh).toFixed(1)} screens`).toBeLessThan(3);
    await expect(page.locator('h1')).toHaveCount(1);
  }
});

test('with a planned car, staying put never looks cheaper than the best plan', async ({ page }) => {
  // "Now" left the planned car out while every other step had it, so the
  // cheapest plan without panels showed €150 dearer than staying.
  await boot(page, { ...PLANNED, ev_active: true, ev_in_bill: false, ev_km_per_year: 15000, baseline: 'BG-TOU', current_screen: 'result' });
  const r = await page.evaluate(() => [...document.querySelectorAll('.v7-hero .v7-ladder [data-rung]')].map((x) => +x.dataset.value));
  expect(r[1]).toBeLessThanOrEqual(r[0] + 0.5);
  expect(r[3]).toBeLessThanOrEqual(r[2] + 0.5);
  await page.locator('.ax-door', { hasText: 'Bill' }).click();
  const bars = await page.locator('.ax-hbar b').allTextContents();
  expect(euros(bars[0])).toBe(Math.round(r[0]));
  expect(euros(await page.locator('.ax-ans .ax-big').textContent())).toBe(Math.round(r[3]));
});

test('a plan picked in Analytics changes every tab, not Home, and lapses when the home changes', async ({ page }) => {
  const errors = await boot(page, { ...PLANNED, current_screen: 'analytics', _an_tab: 'bill' });
  const homeBest = await page.evaluate(() => window.getBestPlan().plan.id);
  await page.locator('.ax-plan').click();
  const row = page.locator('.ax-plan-row').nth(3);
  const id = await row.evaluate((el) => el.getAttribute('onclick').match(/'([^']+)'/)[1]);
  await row.click();
  await expect(page.locator('.ax-plan')).toContainText('Plan you picked');
  expect(await page.evaluate(() => window.getBestPlan().plan.id)).toBe(homeBest);
  await page.locator('.ax-tab', { hasText: 'Solar' }).click();
  await expect(page.locator('.ax-ans')).toContainText('the plan picked above');
  // Leaving the panels out changes the home: back to its best plan, and it says so.
  await page.evaluate(() => { window.toggleSolarModel(); window.setScreen('plans'); });
  await page.locator('.v7-nav-item', { hasText: 'Analytics' }).click();
  await expect(page.locator('.ax-msg')).toContainText('went back to its best plan');
  await expect(page.locator('.ax-plan')).not.toContainText('Plan you picked');
  expect(id).toBeTruthy();
  expect(errors).toEqual([]);
});

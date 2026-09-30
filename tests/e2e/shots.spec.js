import { test } from '@playwright/test';
import { boot, bootFresh } from './support.js';

/**
 * Not an assertion suite — a way to look at the app.
 *
 * Run with `npm run shots`. Everything lands in screenshots/ as a full-page
 * capture at phone width, which is the only width most readers will ever see.
 */

const SHOT = (name) => ({ path: `screenshots/${name}.png`, fullPage: true });

test('first run — the quick answer @shots', async ({ page }) => {
  await bootFresh(page);
  await page.waitForTimeout(400);
  await page.screenshot(SHOT('01-first-run'));
});

test('the answer, closed and open @shots', async ({ page }) => {
  await boot(page);
  await page.screenshot(SHOT('02-answer'));

  const toggle = page.getByText('Show me the working');
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await page.waitForTimeout(300);
  await page.screenshot(SHOT('03-answer-working'));
});

test('explore — plans and compare @shots', async ({ page }) => {
  await boot(page, { current_screen: 'plans' });
  await page.screenshot(SHOT('04-plans'));
  await boot(page, { current_screen: 'compare' });
  await page.screenshot(SHOT('05-compare'));
});

test('simulate — solar, hourly, market @shots', async ({ page }) => {
  await boot(page, { current_screen: 'solar' });
  await page.screenshot(SHOT('06-solar'));
  await boot(page, { current_screen: 'analytics' });
  await page.screenshot(SHOT('07-hourly'));
  await boot(page, { current_screen: 'monitor' });
  await page.screenshot(SHOT('08-market'));
});

test('tools @shots', async ({ page }) => {
  await boot(page, { current_screen: 'more' });
  await page.screenshot(SHOT('09-tools'));
});

test('the payback curve, in the light theme @shots', async ({ page }) => {
  await boot(page, { current_screen: 'solar', theme: 'light', _show_npv_breakdown: true });
  await page.screenshot(SHOT('10-payback-light'));
});

test('sheets — a plan, and the home @shots', async ({ page }) => {
  await boot(page, { current_screen: 'plans' });
  await page.locator('.v7-plan').first().click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'screenshots/11-plan-sheet.png' });
  await boot(page, { current_screen: 'result', _sheet: { kind: 'assume' } });
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'screenshots/12-assume-sheet.png' });
});

test('dark theme @shots', async ({ page }) => {
  await boot(page, { theme: 'dark' });
  await page.screenshot(SHOT('13-home-dark'));
  await boot(page, { theme: 'dark', current_screen: 'plans' });
  await page.screenshot(SHOT('14-plans-dark'));
});

test('setup wizard and landing @shots', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: /Re-run setup/ }).click();
  await page.waitForTimeout(350);
  await page.screenshot(SHOT('15-wizard'));
  await page.evaluate(() => window.setScreen('welcome'));
  await page.waitForTimeout(350);
  await page.screenshot(SHOT('16-landing'));
});

test('solar switch, on and off @shots', async ({ page }) => {
  await boot(page);
  await page.locator('.v7-switch-row').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'screenshots/17-switch-on.png' });
  await page.locator('.v7-switch-row').click();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'screenshots/18-switch-off.png' });
});

test('no-solar Solar tab, home tiles, health sheet @shots', async ({ page }) => {
  await boot(page, { has_solar: false, considering_solar: false, battery_kwh: 0, current_screen: 'solar' });
  await page.screenshot({ path: 'screenshots/19-solar-empty.png' });
  await boot(page);
  await page.locator('.v7-tiles-3').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'screenshots/20-home-tiles.png' });
  await page.locator('.v7-tile-score').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'screenshots/21-health-sheet.png' });
});

test('month by month sheet @shots', async ({ page }) => {
  await boot(page, { current_screen: 'solar', theme: 'dark' });
  await page.locator('.v7-months-card [data-month="6"] rect').first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'screenshots/22-months-july.png' });
  await page.evaluate(() => window.v7GoMonth(11));
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'screenshots/23-months-december.png' });
});

test('month flow on an EV home @shots', async ({ page }) => {
  await boot(page, { current_screen: 'solar', theme: 'dark', chosen_plan: 'EN-EV', ev_active: true,
    ev_in_bill: true, ev_km_per_year: 15000, battery_kwh: 10, charge_from_grid: true });
  await page.locator('.v7-months-card [data-month="11"] rect').first().click();
  await page.waitForTimeout(500);
  await page.locator('#v7-sheet .v7-sheet').evaluate((el) => { el.scrollTop = 400; });
  await page.screenshot({ path: 'screenshots/24-flow-december.png' });
  await page.evaluate(() => window.v7GoMonth(6));
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'screenshots/25-flow-july.png' });
});

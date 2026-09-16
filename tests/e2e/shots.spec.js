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

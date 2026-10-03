import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/** A crash in the page is reported once, with the screen and build, and nothing personal. */
test('an uncaught error is reported once, scrubbed', async ({ page }) => {
  const sent = [];
  await boot(page, { current_screen: 'plans' });
  // After boot: its catch-all route is registered first, and the last one registered wins.
  await page.route('**/api/error', async (route) => { sent.push(route.request().postDataJSON()); await route.fulfill({ status: 200, body: '{}' }); });
  await page.evaluate(() => { for (let i = 0; i < 3; i++) setTimeout(() => { throw new Error('Broke for jo@x.ie at 0871234567'); }, 0); });
  await expect.poll(() => sent.length).toBe(1);
  await page.waitForTimeout(300);
  expect(sent.length).toBe(1);
  expect(sent[0].screen).toBe('plans');
  expect(sent[0].build).toBeTruthy();
  expect(JSON.stringify(sent[0])).not.toMatch(/jo@x\.ie|0871234567/);
});

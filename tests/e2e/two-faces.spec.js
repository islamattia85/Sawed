import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Two roof faces are found where the roof is asked about, not only in My
 * system: a tester with 11 panels south-west and 11 south-east did not know
 * the app could model it.
 */
const NO_SOLAR = { has_solar: false, considering_solar: false, count_A: 0, count_B: 0, battery_kwh: 0 };

test('the solar guide offers two roof faces, any pair of directions', async ({ page }) => {
  const errors = await boot(page, { ...NO_SOLAR, current_screen: 'result' });
  await page.evaluate(() => window.startSolarGuide());
  await page.getByRole('button', { name: /^Start/ }).click();
  await page.locator('.sg-tile', { hasText: 'Two roof faces' }).click();
  await expect(page.locator('.sg-two')).toBeVisible();
  await page.locator('.sg-two-row').nth(0).locator('.sg-chip', { hasText: /^South-west$/ }).click();
  await page.locator('.sg-two-row').nth(1).locator('.sg-chip', { hasText: /^South-east$/ }).click();
  const st = await page.evaluate(() => ({ a: window.state.azimuth_A, b: window.state.azimuth_B, nA: window.state.count_A, nB: window.state.count_B }));
  expect([st.a, st.b]).toEqual([225, 135]);
  expect(st.nB).toBeGreaterThan(0);
  expect(Math.abs(st.nA - st.nB)).toBeLessThanOrEqual(1);
  await page.locator('.sg-two .sg-next').click();
  await expect(page.locator('.sg-k')).toContainText('Step 2');
  expect(errors).toEqual([]);
});

test('suggested sizes keep the roof as the home uses it: on two faces, shared the same way', async ({ page }) => {
  await boot(page, { has_solar: true, considering_solar: true, count_A: 6, count_B: 6, azimuth_A: 135, azimuth_B: 225, tilt_B: 30, current_screen: 'result' });
  const r = await page.evaluate(() => {
    const sw = window.sweepGoalDesigns(); const ds = Array.isArray(sw) ? sw : sw.designs || [];
    const d = ds.find((x) => x.panels === 12) || ds[0]; const c = window.designToConfig(d);
    return { n: ds.length, a: c.count_A, b: c.count_B, p: d.panels };
  });
  expect(r.n).toBeGreaterThan(0);
  expect(r.a + r.b).toBe(r.p);
  expect(Math.abs(r.a - r.b)).toBeLessThanOrEqual(1);
});

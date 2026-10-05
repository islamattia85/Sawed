import { test, expect } from '@playwright/test';
import { boot } from './support.js';

test('a smart-meter home is never offered a plan that needs a day/night meter', async ({ page }) => {
  await boot(page, { meter_type: 'smart' });
  const r = await page.evaluate(() => window.getRecommendation().ranked.map((x) => x.plan.meter || 'smart'));
  expect(r.length).toBeGreaterThan(20);
  expect(r.every((m) => m === 'smart')).toBe(true);
});

test('a day/night meter home gets its Nightsaver plans and 24-hour plans, and no smart plans', async ({ page }) => {
  await boot(page, { meter_type: 'nightsaver' });
  const r = await page.evaluate(() => window.getRecommendation().ranked.map((x) => x.plan.meter));
  expect(r).toContain('nightsaver');
  expect(r.every((m) => m === 'nightsaver' || m === '24hr')).toBe(true);
});

test('rural homes pay the rural standing charge, on every surface that reads it', async ({ page }) => {
  await boot(page, { meter_type: 'smart', area: 'urban' });
  const urban = await page.evaluate(() => { const r = window.getRecommendation(); return { id: r.cheapest.plan.id, net: r.cheapest.net, st: r.cheapest.plan.standing }; });
  await page.evaluate(() => { window.state.area = 'rural'; window.invalidate(); });
  const rural = await page.evaluate((id) => { const r = window.getRecommendation(); const x = r.ranked.find((y) => y.plan.id === id); return { net: x.net, st: x.plan.standing }; }, urban.id);
  expect(rural.st - urban.st).toBeGreaterThan(30);
  expect(rural.net - urban.net).toBeCloseTo(rural.st - urban.st, 0);
  await page.evaluate(() => { window.state.area = 'urban'; window.invalidate(); });
  expect(await page.evaluate((id) => window.getRecommendation().ranked.find((y) => y.plan.id === id).plan.standing, urban.id)).toBe(urban.st);
});

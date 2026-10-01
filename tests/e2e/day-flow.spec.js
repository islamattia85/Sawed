import { test, expect } from '@playwright/test';
import { boot } from './support.js';

test('the day chart balances every hour, and tapping an hour says it in words', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'solar', _di_season: 'winter', _solar_detail_open: true });
  const box = page.locator('.section-title', { hasText: 'Day inspector' }).first().locator('xpath=following-sibling::div[1]');
  await box.scrollIntoViewIfNeeded();
  await expect(box).toContainText('Tap any hour');
  await expect(box).toContainText('↑ buying · ↓ selling');
  await box.locator('svg rect[onclick]').nth(18).click();
  await expect(box).toContainText('18:00–19:00');
  // Supply equals use in every hour of the simulated day.
  const off = await page.evaluate(() => {
    const plan = window.getRecommendation().best.plan, s = window.sim(plan.id), bad = [];
    for (let h = 0; h < 24; h++) {
      const i = 18 * 24 + h;
      const supply = s.gen[i] + s.battery_discharge[i] * Math.sqrt(window.state.battery_eff || 0.9) + s.grid_import[i];
      const use = s.cons[i] + s.battery_charge[i] + s.grid_export[i] + (s.curtailed ? s.curtailed[i] : 0);
      if (Math.abs(supply - use) > 0.02) bad.push([h, supply, use]);
    }
    return bad;
  });
  expect(off).toEqual([]);
  expect(errors).toEqual([]);
});

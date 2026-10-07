// @ts-check
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const SHOTS = process.env.DESK_SHOTS;
const SCREENS = ['result', 'plans', 'analytics', 'updates', 'profile'];

for (const width of [1440, 1024]) {
  test(`desktop ${width}: sidebar fully visible, no sideways scroll, readable width`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page, { has_solar: true, solar_planned: true, battery_kwh: 9 });
    for (const s of SCREENS) {
      await page.evaluate((id) => window.setScreen(id), s);
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const nav = document.querySelector('.v7-nav')?.getBoundingClientRect();
        const scr = document.querySelector('.screen')?.getBoundingClientRect();
        return { navL: nav?.left, navR: nav?.right, navH: nav?.height, scrW: scr?.width,
          over: document.documentElement.scrollWidth - innerWidth };
      });
      expect(m.navL, `${s}: sidebar starts on screen`).toBeGreaterThanOrEqual(0);
      expect(m.navH, `${s}: sidebar is a column`).toBeGreaterThan(200);
      expect(m.over, `${s}: no sideways scroll`).toBeLessThanOrEqual(1);
      expect(m.scrW, `${s}: content keeps a readable width`).toBeLessThanOrEqual(1100);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-${s}.png` });
    }
  });
}

test('phone keeps the bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const r = await page.evaluate(() => document.querySelector('.v7-nav').getBoundingClientRect());
  expect(r.bottom).toBeGreaterThan(780);
  expect(r.height).toBeLessThan(100);
});

// @ts-check
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

// The website layout: a top menu named by task, pages at a readable width,
// plan details beside the list, and My home as a page with Start over.
const SHOTS = process.env.DESK_SHOTS;
const SCREENS = ['result', 'plans', 'analytics', 'myhome', 'updates', 'profile'];

for (const width of [1440, 1024]) {
  test(`website ${width}: top menu, no sideways scroll, readable width`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page, { has_solar: true, solar_planned: true, battery_kwh: 9 });
    for (const s of SCREENS) {
      await page.evaluate((id) => window.setScreen(id), s);
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => ({
        links: document.querySelectorAll('.web-links a').length,
        bar: !!document.querySelector('.v7-nav') && getComputedStyle(document.querySelector('.v7-nav')).display !== 'none',
        scrW: document.querySelector('.screen')?.getBoundingClientRect().width,
        over: document.documentElement.scrollWidth - innerWidth,
      }));
      expect(m.links, `${s}: top menu`).toBe(6);
      expect(m.bar, `${s}: no phone bar`).toBe(false);
      expect(m.over, `${s}: no sideways scroll`).toBeLessThanOrEqual(1);
      expect(m.scrW, `${s}: readable width`).toBeLessThanOrEqual(1280);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-${s}.png` });
    }
  });
}

test('website: a plan opens beside the list, not over it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, { has_solar: true, solar_planned: true, battery_kwh: 9 });
  await page.evaluate(() => window.setScreen('plans'));
  await expect(page.locator('.web-detail')).toBeVisible();
  const second = page.locator('.v7-plan').nth(1);
  const name = await second.locator('.plan-name').innerText();
  await second.click();
  await expect(page.locator('#v7-sheet')).toHaveCount(0);
  await expect(page.locator('.web-detail')).toContainText(name);
  await expect(second).toHaveClass(/is-sel/);
});

test('website: My home is a page with the answers and Start over', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page);
  await page.evaluate(() => window.v7Sheet('home'));
  await expect(page.locator('#v7-sheet')).toHaveCount(0);
  await expect(page.locator('#wh-home')).toBeVisible();
  await expect(page.locator('#wh-system')).toBeVisible();
  await expect(page.locator('#wh-reset')).toContainText('Start over');
  expect(page.url()).toContain('#myhome');
});

test('phone keeps the bottom bar and no top menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const r = await page.evaluate(() => document.querySelector('.v7-nav').getBoundingClientRect());
  expect(r.bottom).toBeGreaterThan(780);
  expect(r.height).toBeLessThan(100);
  await expect(page.locator('.web-links')).toBeHidden();
});

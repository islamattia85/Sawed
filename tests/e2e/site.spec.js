// @ts-check
import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

// The website at "/" is the full product with a front page; "/app" is the mobile app.
for (const width of [390, 1440]) {
  test(`website ${width}: front page, plans table, start a check in place`, async ({ page }) => {
    await isolate(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('.wl-site .wl-h1')).toContainText('priced on your home');
    await expect(page.locator('.wl-demo .wl-rrow')).toHaveCount(4);
    await page.locator('.wl-seg button', { hasText: '12 panels' }).click();
    await expect(page.locator('.wl-demo .wl-rrow')).toHaveCount(4);
    await expect(page.locator('#plans tbody tr').first()).toBeVisible();
    await expect(page.locator('a[href="/app"]').first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: /Am I paying too much/ }).click();
    await page.waitForFunction(() => window.state.current_screen === 'flow');
    expect(new URL(page.url()).pathname).toBe('/');
  });
}

test('the mobile app opens at /app with its own start', async ({ page }) => {
  await isolate(page);
  await page.goto('/app');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('.wl-app')).toBeVisible();
  await expect(page.locator('.wl-site')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Planning solar, a battery or an EV/ })).toBeVisible();
});

test('the website logo opens the front page, even once set up', async ({ page }) => {
  const { boot } = await import('./support.js');
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, {}, '/');
  await page.locator('.web-logo').click();
  await expect(page.locator('.wl-site')).toBeVisible();
  await page.locator('.wl-bar .wl-btn-p').click();
  expect(await page.evaluate(() => window.state.current_screen)).toBe('result');
});
test('front page uses the full width after leaving setup', async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Am I paying too much/ }).click(); await page.waitForTimeout(400);
  await page.goBack(); await page.waitForTimeout(600);
  const w = await page.evaluate(() => document.querySelector('.pk-land').getBoundingClientRect().width);
  expect(w).toBeGreaterThan(1400);
});

test('the setup questions use the full width, in two panes', async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.getByRole('button', { name: /Am I paying too much/ }).click();
  await page.waitForFunction(() => window.state.current_screen === 'flow');
  const g = await page.evaluate(() => document.querySelector('.fl-grid').getBoundingClientRect().width);
  expect(g).toBeGreaterThan(1000);
});

test('no empty gap between the answer and what follows it', async ({ page }) => {
  const { boot } = await import('./support.js');
  await page.setViewportSize({ width: 1850, height: 960 });
  await boot(page, {}, '/');
  const gap = await page.evaluate(() => {
    const next = document.querySelector('.web-after').firstElementChild.getBoundingClientRect().top;
    const above = [...document.querySelectorAll('.screen > *')].map((e) => e.getBoundingClientRect().bottom);
    return next - Math.max(...above);
  });
  expect(gap).toBeLessThan(120);
});

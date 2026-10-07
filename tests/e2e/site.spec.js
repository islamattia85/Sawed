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
    await expect(page.locator('.wl-site .wl-h1')).toContainText('Should you get solar');
    await expect(page.locator('.wl-demo .wl-rrow')).toHaveCount(4);
    await page.locator('.wl-seg[aria-label="Solar panels"] button', { hasText: '12' }).click();
    await expect(page.locator('.wl-demo .wl-rrow')).toHaveCount(4);
    if (width < 640) await page.locator('.wl-table-open').click();
    await expect(page.locator('#plans tbody tr').first()).toBeVisible();
    await expect(page.locator('a[href="/app"]').first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Just compare plans' }).click();
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
  await page.getByRole('button', { name: 'Just compare plans' }).click(); await page.waitForTimeout(400);
  await page.goBack(); await page.waitForTimeout(600);
  const w = await page.evaluate(() => document.querySelector('.pk-land').getBoundingClientRect().width);
  expect(w).toBeGreaterThan(1400);
});

test('the setup questions use the full width, in two panes', async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.getByRole('button', { name: 'Just compare plans' }).click();
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

test('the front page gives a real sample report for an email, and leaves your own answers alone', async ({ page }) => {
  const { boot } = await import('./support.js');
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, { current_screen: 'welcome', annual_kwh: 3100, usage_input_mode: 'kwh' }, '/');
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  const before = await page.evaluate(() => JSON.stringify({ k: window.state.annual_kwh, b: window.state.baseline, s: window.state.has_solar }));
  await page.locator('#wl-sample-go').click();
  await expect(page.locator('#wl-sample-msg')).toContainText('Enter an email');
  await page.fill('#wl-sample-email', 'test@example.ie');
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('#wl-sample-go').click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  await page.waitForFunction(() => window.state.annual_kwh === 3100);
  const after = await page.evaluate(() => JSON.stringify({ k: window.state.annual_kwh, b: window.state.baseline, s: window.state.has_solar }));
  expect(after).toBe(before);
  expect(await page.evaluate(() => window.state.lead_queue.some((l) => l.source === 'sample_report'))).toBe(true);
});

test('Everything in Peakless lists every part, and each link goes somewhere', async ({ page }) => {
  const { boot } = await import('./support.js');
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, {}, '/');
  await page.locator('.web-menu summary').click();
  await page.locator('.web-menu-list a', { hasText: 'Everything' }).click();
  await expect(page.locator('.web-all-it')).toHaveCount(20);
  await page.locator('.web-all-it', { hasText: 'Check an installer' }).click();
  expect(await page.evaluate(() => window.state._sheet && window.state._sheet.kind)).toBe('quote');
});

test('the logo on the front page stays on the front page', async ({ page }) => {
  const { boot } = await import('./support.js');
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, {}, '/');
  await page.locator('.web-logo').click();
  await expect(page.locator('.wl-site')).toBeVisible();
  await page.locator('.wl-logo').click();
  await page.waitForTimeout(500);
  await expect(page.locator('.wl-site')).toBeVisible();
});

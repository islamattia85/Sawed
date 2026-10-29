// @ts-check
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/*
 * The private test (29 Oct 2026): a link for neighbours to try. Nobody is
 * offered an account, so each home stays on its own device and nothing of it
 * reaches the database, and every screen says it is a test version. Both are
 * switches in src/features.js; the account tests switch accounts back on.
 */
const UPDATES = { current_screen: 'updates' };

test('no one is offered an account, anywhere', async ({ page }) => {
  const errors = await boot(page, UPDATES);
  await expect(page.locator('.screen')).toBeVisible();
  await expect(page.locator('.profile-nav-btn')).toHaveCount(0);
  for (const screen of ['updates', 'account', 'profile']) {
    await page.evaluate((s) => window.setScreen(s), screen);
    const text = await page.locator('body').innerText();
    expect(text, screen).not.toMatch(/Sign in|free account|I have an account/i);
  }
  // The sign-up sheet stays shut even if something asks for it.
  await page.evaluate(() => window.meOpenAuth('signup'));
  await expect(page.locator('#auth-modal-root')).toHaveCount(0);
  // The website's menu has no Sign in line either.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.setScreen('result'));
  await expect(page.locator('.web-menu-list a', { hasText: 'Sign in' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('every screen says it is a test version, right under its top bar', async ({ page }) => {
  const check = async (name) => {
    const line = page.locator('.test-line');
    await expect(line, name).toHaveCount(1);
    await expect(line, name).toContainText('Test version. Figures are estimates');
    expect(await line.evaluate((el) => !!el.previousElementSibling
      && el.previousElementSibling.matches('header.topbar, header.wl-bar, .fl-top')), name).toBe(true);
  };
  // Where a neighbour lands first: the website, then the start of setup, then setup itself.
  await boot(page, { onboarding_complete: false, current_screen: 'welcome' }, '/');
  await check('front page');
  await boot(page, { onboarding_complete: false, current_screen: 'welcome' });
  await check('welcome');
  await page.evaluate(() => window.startFlow('full'));
  await check('setup');
  // And every screen of the answer.
  await boot(page, UPDATES);
  for (const screen of ['result', 'plans', 'updates', 'myhome']) {
    await page.evaluate((s) => window.setScreen(s), screen);
    await check(screen);
  }
  await page.evaluate(() => window.anTab('bill'));
  await check('analytics');
});

test('with the switches back on, accounts return and the line goes', async ({ page }) => {
  await page.addInitScript(() => { window.__SAWED_FEATURES = { accounts: true, testVersion: false }; });
  await boot(page, UPDATES);
  await expect(page.locator('.profile-nav-btn').first()).toBeVisible();
  await expect(page.locator('.test-line')).toHaveCount(0);
});

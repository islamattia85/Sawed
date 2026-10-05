import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Me: every tap goes where it says, and Back undoes exactly one step.
 * Sheets had no history entry of their own, so Back changed the screen behind
 * an open sheet and the sheet followed to the next screen; the quote upload
 * and the EV card left Me altogether.
 */
const where = (page) => page.evaluate(() => `${window.state.current_screen}${window.state._sheet ? `+${window.state._sheet.kind}` : ''}`);

test('Back closes a sheet opened on Me, and stays on Me', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'result', has_solar: true, considering_solar: true, count_A: 10 });
  await page.evaluate(() => window.setScreen('plans'));
  await page.evaluate(() => window.setScreen('profile'));
  await page.locator('.pf-row', { hasText: 'Home and usage' }).click();
  expect(await where(page)).toBe('profile+home');
  await page.goBack();
  await expect.poll(() => where(page)).toBe('profile');
  // The next Back is the screen before Me.
  await page.goBack();
  await expect.poll(() => where(page)).toBe('plans');
  expect(errors).toEqual([]);
});

test('a sheet closed by its own button costs no extra Back', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.evaluate(() => window.setScreen('plans'));
  await page.evaluate(() => window.setScreen('profile'));
  await page.locator('.pf-row', { hasText: 'Solar and battery' }).click();
  await page.evaluate(() => window.v7Sheet(null));
  expect(await where(page)).toBe('profile');
  await page.goBack();
  await expect.poll(() => where(page)).toBe('plans');
});

test('a link inside a sheet leaves for its screen, and Back returns to Me', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.evaluate(() => window.setScreen('profile'));
  await page.evaluate(() => { window.v7Sheet('home'); window.v7Sheet(null); window.setScreen('plans'); });
  expect(await where(page)).toBe('plans');
  await page.goBack();
  await expect.poll(() => where(page)).toBe('profile');
});

test('uploading a quote and editing the EV happen on Me, like home and system', async ({ page }) => {
  await boot(page, { current_screen: 'result', ev_active: true, ev_in_bill: true, ev_km_per_year: 16000 });
  await page.evaluate(() => window.setScreen('profile'));
  await page.locator('.me-add', { hasText: 'Upload an installer' }).click();
  expect(await where(page)).toBe('profile+quote');
  await page.evaluate(() => window.v7Sheet(null));
  await page.locator('.pf-row', { hasText: /^EV/ }).click();
  expect(await where(page)).toBe('ev-guide');
});

test('Profile ends with the way into account and settings', async ({ page }) => {
  await boot(page, { current_screen: 'profile' });
  await page.locator('.me-row', { hasText: 'Account and settings' }).click();
  expect(await page.evaluate(() => window.state.current_screen)).toBe('account');
  await expect(page.locator('.screen.account')).toContainText('Privacy and your data');
});

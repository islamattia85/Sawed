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
  await page.evaluate(() => window.setScreen('me'));
  await page.locator('.me-card', { hasText: 'My home' }).click();
  expect(await where(page)).toBe('me+home');
  await page.goBack();
  await expect.poll(() => where(page)).toBe('me');
  // The next Back is the screen before Me.
  await page.goBack();
  await expect.poll(() => where(page)).toBe('plans');
  expect(errors).toEqual([]);
});

test('a sheet closed by its own button costs no extra Back', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.evaluate(() => window.setScreen('plans'));
  await page.evaluate(() => window.setScreen('me'));
  await page.locator('.me-card', { hasText: 'My system' }).click();
  await page.evaluate(() => window.v7Sheet(null));
  expect(await where(page)).toBe('me');
  await page.goBack();
  await expect.poll(() => where(page)).toBe('plans');
});

test('a link inside a sheet leaves for its screen, and Back returns to Me', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.evaluate(() => window.setScreen('me'));
  await page.evaluate(() => { window.v7Sheet('home'); window.v7Sheet(null); window.setScreen('plans'); });
  expect(await where(page)).toBe('plans');
  await page.goBack();
  await expect.poll(() => where(page)).toBe('me');
});

test('uploading a quote and editing the EV happen on Me, like home and system', async ({ page }) => {
  await boot(page, { current_screen: 'result', ev_active: true, ev_in_bill: true, ev_km_per_year: 16000 });
  await page.evaluate(() => window.setScreen('me'));
  await page.locator('.me-add', { hasText: 'Upload an installer' }).click();
  expect(await where(page)).toBe('me+quote');
  await page.evaluate(() => window.v7Sheet(null));
  await page.locator('.me-card', { hasText: 'My EV' }).click();
  expect(await where(page)).toBe('ev-guide');
});

test('quote requests come last on Me, so nothing moves when they load', async ({ page }) => {
  await boot(page, { current_screen: 'me' });
  const titles = await page.locator('.screen.me .section-title').allTextContents();
  expect(titles[titles.length - 1]).toBe('Quote requests');
});

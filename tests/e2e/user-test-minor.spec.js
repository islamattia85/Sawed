// @ts-check
import { test, expect } from '@playwright/test';
import { isolate, boot } from './support.js';

// The smaller things the round of user testing found, each held to the fix.

test('the usage question waits while plans are being compared, then comes back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { current_screen: 'plans', askConsent: true }, '/#plans');
  await expect(page.locator('.consent-bar')).toBeVisible();
  const cmp = page.locator('.v7-cmp');
  await cmp.nth(0).click();
  await cmp.nth(1).click();
  await expect(page.locator('.cmp-tray')).toBeVisible();
  await expect(page.locator('.consent-bar')).toBeHidden();
  await page.locator('.cmp-tray-clear').click();
  await expect(page.locator('.consent-bar')).toBeVisible();
});

test('the stress map says how far it has got, and a map worked out once is kept', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, { current_screen: 'solar', has_solar: true, solar_planned: true, count_A: 12, battery_kwh: 5 });
  await page.evaluate(() => { window.stressSet('reset'); window.anTab('solar'); });
  const card = page.locator('#stress-card');
  await expect(card.locator('.st-ans')).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => window.stressSet('preset', 'crisis'));
  await expect(card.locator('.st-prog')).toContainText(/Filling in the map: \d+ of 36/, { timeout: 30_000 });
  await expect(card.locator('.st-prog')).toHaveCount(0, { timeout: 90_000 });
  await page.evaluate(() => window.stressSet('reset'));
  await expect(card.locator('.st-prog')).toHaveCount(0, { timeout: 90_000 });
  // Back to the crisis: already worked out, so no waiting.
  await page.evaluate(() => window.stressSet('preset', 'crisis'));
  await expect(card.locator('.st-prog')).toHaveCount(0);
});

test('each plan family is written one way', async ({ page }) => {
  await boot(page);
  const spaced = await page.evaluate(() => window.TARIFFS.filter((p) => /Home Electric \+/.test(p.plan)).map((p) => p.plan));
  expect(spaced).toEqual([]);
});

test('the meter file is one to-do, not two with different points', async ({ page }) => {
  await boot(page, { current_screen: 'updates', usage_input_mode: 'kwh', annual_kwh: 4200, _csv_imported: false });
  const titles = await page.evaluate(() => window.householdScore().quests.map((q) => q.title));
  expect(titles.filter((t) => /meter (file|data)/i.test(t)), titles.join(' | ')).toHaveLength(1);
});

test('setup: the map waits for an answer, the stages are text, and the euro sign comes before a price', async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
  await page.evaluate(() => window.siteGo('solar'));
  await expect(page.locator('.fl-q h2')).toHaveText('Where in Ireland is the home?');
  await expect(page.locator('.region-map-zone.active')).toHaveCount(0);
  // The stages say where you are; none of them is a button or looks like one.
  await expect(page.locator('.fl-chap button')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.fl-chap li')).borderTopWidth)).toBe('0px');
  for (const [q, v] of [['where', 'east'], ['house', 'semi'], ['roof', 'S'], ['tilt', 35], ['bill', 250], ['meter', 'smart'], ['area', 'urban'],
    ['plan', 'EI-24'], ['disc', 0], ['heat', 'gas'], ['gas', 'no'], ['night', 'no'], ['system', 'custom'], ['panels', 12], ['battery', 5]]) {
    await page.evaluate(([q, v]) => window.flowAnswer(q, v), [q, v]);
  }
  const box = page.locator('#flow-own-price');
  await expect(box).toBeVisible();
  expect(await box.evaluate((el) => el.previousElementSibling && el.previousElementSibling.textContent)).toBe('€');
});

test('in the website menu, Sign in is a line like the others', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, {}, '/#result');
  await page.locator('.web-menu summary').click();
  const signIn = page.locator('.web-menu-list a', { hasText: 'Sign in' });
  await expect(signIn).toBeVisible();
  const [a, b] = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.web-menu-list a')];
    const s = links.find((l) => /Sign in/.test(l.textContent));
    return [getComputedStyle(s).fontSize, getComputedStyle(links[0]).fontSize];
  });
  expect(a).toBe(b);
  await signIn.click();
  await expect(page.locator('#auth-modal-root')).toHaveCount(1);
});

import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Direction section 3 (13 Oct 2026): the quarterly AI suggestions are gone,
 * and the AI quote reader is built but off (src/features.js). A quote is
 * checked from the figures the person types in, wherever they start.
 */

const HOME = { has_solar: true, considering_solar: true, count_A: 12, battery_kwh: 5, solar_planned: true };

test('with the quote reader off, nothing offers an upload', async ({ page }) => {
  const errors = await boot(page, { ...HOME, current_screen: 'profile' });
  await expect(page.locator('.screen')).not.toContainText(/Upload an installer/);
  await page.evaluate(() => window.setScreen('more'));
  await expect(page.locator('.screen')).not.toContainText(/Upload an installer/);
  await expect(page.locator('.screen')).toContainText('Check an installer’s quote');
  await page.evaluate(() => window.openMySystem());
  await expect(page.locator('#v7-sheet')).toBeVisible();
  await expect(page.locator('#v7-sheet')).not.toContainText(/from an installer's quote/);
  await page.evaluate(() => { window.v7Sheet(null); window.setScreen('auditor'); });
  await expect(page.locator('.screen')).not.toContainText(/Upload the quote/);
  // An old link to the quote sheet offers no file, only the typed check.
  await page.evaluate(() => window.v7Sheet('quote'));
  await expect(page.locator('#v7-sheet input[type=file]')).toHaveCount(0);
  await page.locator('#v7-sheet').getByRole('button', { name: 'Check my quote' }).click();
  expect(await page.evaluate(() => [window.state.current_screen, !!window.state._sheet])).toEqual(['auditor', false]);
  expect(errors).toEqual([]);
});

test('the solar guide asks for the price, and offers no reading of the quote', async ({ page }) => {
  await boot(page, { current_screen: 'result', has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  await page.evaluate(() => window.startSolarGuide());
  await page.locator('.sg-tile', { hasText: 'South' }).first().click();
  await page.getByRole('button', { name: /^Next/ }).click();
  await expect(page.locator('.sg-own').first()).toBeVisible();
  await expect(page.locator('.sg-link', { hasText: /read it for me/ })).toHaveCount(0);
});

test('"Is my quote fair?" lands on the typed check, which judges the price and works out the payback', async ({ page }) => {
  const errors = await boot(page, { ...HOME, current_screen: 'welcome' });
  await page.evaluate(() => window.siteGo('quote', true));
  expect(await page.evaluate(() => window.state.current_screen)).toBe('auditor');
  await page.fill('#aud-price', '11500');
  await page.fill('#aud-panels', '12');
  await page.fill('#aud-battery', '5');
  await page.click('.aud-btn');
  const result = page.locator('#audit-result');
  await expect(result).toContainText(/Verdict/i);
  await expect(result).toContainText(/Usual price range/i);
  await expect(result).toContainText(/Payback/i);
  // The Solar tab's quote button goes to the same place.
  await page.evaluate(() => window.setScreen('solar'));
  await page.evaluate(() => window.openQuoteCheck());
  expect(await page.evaluate(() => [window.state.current_screen, !!window.state._sheet])).toEqual(['auditor', false]);
  expect(errors).toEqual([]);
});

test('the quarterly suggestions are gone, and a saved home loses them', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'updates',
    advice: { quarter: '2026-Q4', key: 'x', at: '2026-10-01T09:00:00Z', items: [{ title: 'Run the dishwasher after 11pm', why: 'x', saving_eur: 40, effort: 'easy' }] } });
  await expect(page.locator('.screen')).not.toContainText(/This quarter|suggestions|dishwasher/i);
  await expect(page.locator('.adv')).toHaveCount(0);
  expect(await page.evaluate(() => 'advice' in window.state)).toBe(false);
  const sent = await page.evaluate(() => 'advice' in window.__sync.cloudCopy({ ...window.state, advice: { items: [] } }));
  expect(sent).toBe(false);
  expect(errors).toEqual([]);
});

test('the privacy notice and the terms name no AI service, and say quote figures are typed in', async ({ page }) => {
  await boot(page, { current_screen: 'privacy' });
  const privacy = await page.locator('.screen').innerText();
  expect(privacy).not.toMatch(/Anthropic|Claude|quarterly suggestions/);
  expect(privacy).toMatch(/Figures you type in from an installer’s quote/);
  expect(privacy).toMatch(/uses no AI/);
  await page.evaluate(() => window.setScreen('terms'));
  const terms = await page.locator('.screen').innerText();
  expect(terms).not.toMatch(/\bAI\b|Anthropic|Claude/);
});

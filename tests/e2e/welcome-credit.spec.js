import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Welcome credits: a one-off sum for joining, shown on the plan, kept out of
 * the yearly figure (the price the plan goes on charging), and given as a
 * first-year total in the plan's sheet. Never offered on a plan from the
 * supplier the home is already with: it is for new customers.
 */
const euros = (t) => Number(String(t).replace(/[^\d.]/g, ''));

test('a plan with a welcome credit says so, and its sheet gives the first year with it', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'plans', baseline: 'BG-TOU', _plans_all: true });
  const card = page.locator('.v7-plan', { hasText: 'Home Electric+ Saver 16%' });
  await expect(card.locator('.v7-flag.is-gift')).toHaveText(/\+€30 welcome credit/);
  const year = euros(await card.locator('.plan-cost').textContent());
  await card.click();
  const note = page.locator('.v7-note.is-gift');
  await expect(note).toContainText('€30 welcome credit');
  await expect(note).toContainText(`about €${(year - 30).toLocaleString('en-IE')}`);
  // The discount already in the rates is named, so nobody adds it twice.
  await expect(note).toContainText('include the 16% new-customer discount, which lasts 12 months');
  // The yearly figure is unchanged by the credit.
  expect(euros(await page.locator('.v7-sheet-figs .v7-fig').first().textContent())).toBe(year);
  expect(errors).toEqual([]);
});

test('no welcome credit on a plan from the supplier the home is already with', async ({ page }) => {
  await boot(page, { current_screen: 'plans', baseline: 'EI-SST', _plans_all: true });
  const card = page.locator('.v7-plan', { hasText: 'Home Electric+ Saver 16%' });
  await expect(card).toBeVisible();
  await expect(card.locator('.v7-flag.is-gift')).toHaveCount(0);
});

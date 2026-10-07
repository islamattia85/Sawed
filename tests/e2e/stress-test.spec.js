import { test, expect } from '@playwright/test';
import { boot } from './support.js';

test('the Solar tab stress test: a tougher future lengthens the payback, and the map fills in', async ({ page }) => {
  await boot(page, { has_solar: true, solar_planned: true, count_A: 14, battery_kwh: 10, heating_type: 'gas', install_cost: 12000, grant_seai: 1800 });
  await page.evaluate(() => anTab('solar'));
  const card = page.locator('#stress-card');
  await expect(card.locator('.st-ans')).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText('at today’s prices');
  await page.evaluate(() => stressSet('preset', 'both'));
  await expect(card).toContainText('today:', { timeout: 30000 });
  const yrs = await card.locator('.st-ans b').first().innerText();
  const now = await card.locator('.st-ans small').nth(1).innerText();
  const n = (t) => (/never/.test(t) ? 99 : parseFloat(t.replace(/[^\d.]/g, '')));
  expect(n(yrs)).toBeGreaterThan(n(now));
  // The map fills in, a square at a time.
  await expect.poll(() => page.locator('#stress-card .st-map rect').evaluateAll((r) => r.filter((x) => !/working/.test(x.textContent)).length), { timeout: 90000 }).toBe(36);
  await expect(card.locator('.ax-note').last()).toContainText('pays back within');
});

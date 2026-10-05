import { test, expect } from '@playwright/test';

test('a terraced house is offered systems that fit its roof, and picking one sets it', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { startFlow('full'); flowAnswer('bill', 150); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0); flowAnswer('heat', 'heatpump'); flowAnswer('heattime', 'day'); flowAnswer('solar', 'thinking'); flowAnswer('where', 'east'); flowAnswer('house', 'terraced'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); });
  await expect(page.locator('.fl-q h2')).toHaveText('Pick a system', { timeout: 30000 });
  const cards = page.locator('.fl-opt', { hasText: 'panels' }).filter({ hasNotText: 'own size' });
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  for (const t of await cards.allTextContents()) expect(Number(t.match(/(\d+) panels/)[1])).toBeLessThanOrEqual(10);
  const n = Number((await cards.first().textContent()).match(/(\d+) panels/)[1]);
  await cards.first().click();
  expect(await page.evaluate(() => state.count_A + state.count_B)).toBe(n);
});


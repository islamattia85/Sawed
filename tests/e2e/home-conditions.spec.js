import { test, expect } from '@playwright/test';
import { runScenario, SCENARIOS } from './run-scenario.js';

/**
 * Home's conditions, folded (30 Oct 2026). Under the saving the card stacked
 * every condition it rests on, a paragraph each: the battery charging from
 * the grid at night and the plan if it doesn't, "You don't need an EV for this
 * plan…", a price rise. The owner: too busy, nobody reads it that way. The
 * saving and the plan lead; the conditions are one line that opens on a tap.
 */
test('the saving and the plan lead; the conditions are one line that opens on a tap', async ({ page }, testInfo) => {
  test.setTimeout(150000);
  await runScenario(page, SCENARIOS.find((s) => s.id === 'B2-hp_solar_batt'));
  await page.evaluate(() => window.setScreen('result'));
  const conds = page.locator('.v7-conds');
  await expect(conds).toHaveCount(1);
  const n = await conds.locator('li').count();
  expect(n).toBeGreaterThan(0);
  await expect(conds.locator('summary')).toHaveText(n === 1 ? 'Based on one condition' : `Based on ${n} conditions`);
  // Closed: none of the conditions is on screen, and no other note stands in for them.
  await expect(conds.locator('li').first()).toBeHidden();
  await expect(page.locator('.v7-note.gc-note, div.v7-evnote:not(.is-warn)')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('closed.png') });
  await conds.locator('summary').click();
  await expect(conds.locator('li').first()).toBeVisible();
  // Each condition is one short line, not a paragraph.
  const longest = await conds.locator('li').evaluateAll((ls) => Math.max(...ls.map((l) => l.textContent.trim().length)));
  expect(longest).toBeLessThan(160);
  await page.screenshot({ path: testInfo.outputPath('open.png') });
});

/**
 * The plan sheet, the same way: under the rates, its contract on one line;
 * the discount, the battery, the levy, the source and any price change open
 * on a tap. Stacked, they were a page of text above the switch button.
 */
test('the plan sheet: its contract in view, the rest of its details a tap away, the switch button close', async ({ page }) => {
  test.setTimeout(150000);
  await runScenario(page, SCENARIOS.find((s) => s.id === 'B2-hp_solar_batt'));
  await page.evaluate(() => { window.setScreen('plans'); window.v7Sheet('plan', window.getRecommendation().best.plan.id); });
  const sheet = page.locator('#v7-sheet');
  const more = sheet.locator('.v7-plan-more');
  await expect(more).toHaveCount(1);
  await expect(more.locator('summary')).toContainText(/contract|Plan details/);
  await expect(more.locator('li').first()).toBeHidden();
  // Closed, no note box stands between the rates and the switch button.
  await expect(sheet.locator('div.v7-note:not(.is-check), div.v7-fine:has-text("PSO")')).toHaveCount(0);
  await more.locator('summary').click();
  await expect(sheet.locator('li', { hasText: 'PSO levy' })).toBeVisible();
  await expect(sheet.locator('li', { hasText: 'Battery:' })).toBeVisible();
  await expect(sheet.locator('li', { hasText: 'Rates read from' })).toBeVisible();
  const longest = await more.locator('li').evaluateAll((ls) => Math.max(...ls.map((l) => l.textContent.trim().length)));
  expect(longest).toBeLessThan(170);
});

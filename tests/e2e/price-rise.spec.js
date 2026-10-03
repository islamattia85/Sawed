import { test, expect } from '@playwright/test';
import { boot } from './support.js';

// Before Energia's 12 Oct 2026 rise: the current plan is priced with the rise
// from that date, as every other plan is, so the best can never cost more.
test('a current plan with an announced rise counts it, and the best plan is never dearer', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-03T12:00:00Z'));
  for (const id of ['EN-SMART-24-HOUR', 'EN-SMART', 'EN-24', 'BG-24']) {
    await boot(page, { baseline: id, has_solar: false, considering_solar: false, count_A: 0, count_B: 0, battery_kwh: 0, ev_active: false, current_screen: 'result' });
    const r = await page.evaluate(() => { const rec = getRecommendation(); const own = rec.ranked.find((x) => x.plan.id === state.baseline);
      return { base: rec.baseCost, best: rec.best.net, own: own ? own.net : null }; });
    expect(r.best, id).toBeLessThanOrEqual(r.base + 0.5);
    if (r.own != null) expect(Math.abs(r.base - r.own), id).toBeLessThan(1);   // the same figure as in the ranking
  }
  await boot(page, { baseline: 'EN-SMART-24-HOUR', current_screen: 'result' });
  await expect(page.locator('.v7-evnote', { hasText: 'raises prices' })).toContainText('Energia raises prices on');
});

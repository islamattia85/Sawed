import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

const fresh = async (page) => { await isolate(page); await page.goto('/?fresh'); await page.waitForFunction(() => window.__bootSettled === true); };
const setup = (page, extra) => page.evaluate((x) => {
  startFlow('full'); flowAnswer('bill', x.bill); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0);
  flowAnswer('heat', 'gas'); flowAnswer('night', 'no');
  if (x.panels){ flowAnswer('solar', 'have'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); flowAnswer('panels', x.panels); flowAnswer('battery', x.batt || 0); flowAnswer('price', 0); flowAnswer('grant', 'no'); }
  else flowAnswer('solar', 'no');
  if (x.evtime){ flowAnswer('ev', 'have'); flowAnswer('km', 15000); flowAnswer('car', 17); flowAnswer('evtime', x.evtime); } else flowAnswer('ev', 'no');
  flowFinish();
  const r = window.getRecommendation();
  return { cur: r.ranked.find((y) => y.plan.id === 'EI-24').net, best: r.ranked[0].plan.id, kwh: Object.values(window.state.bills).reduce((a, b) => a + b, 0) };
}, extra);

test('a home with panels already on the roof is priced at the bill it gave, not as a net earner', async ({ page }) => {
  await fresh(page);
  const r = await setup(page, { bill: 140, panels: 9 });
  expect(r.cur).toBeGreaterThan(140 * 6 - 25);
  expect(r.cur).toBeLessThan(140 * 6 + 25);
});

test('with a battery too, the bill still settles where it was given', async ({ page }) => {
  await fresh(page);
  const r = await setup(page, { bill: 120, panels: 9, batt: 10 });
  expect(Math.abs(r.cur - 720)).toBeLessThan(25);
  expect(r.kwh).toBeLessThan(9000);
});

test('a car charged in the evening is not priced as if on a night timer', async ({ page }) => {
  await fresh(page);
  const night = await setup(page, { bill: 300, evtime: 'night' });
  await fresh(page);
  const eve = await setup(page, { bill: 300, evtime: 'evening' });
  expect(night.best).not.toBe(eve.best);
});

test('a meter file’s export is paid for at each plan’s export rate', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Am I paying too much/ }).click();
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  for (let d = 1; d <= 28; d++) for (let h = 1; h <= 24; h++) {
    const t = `${String(d).padStart(2, '0')}-09-2026 ${String(h % 24).padStart(2, '0')}:00`;
    rows.push(`1,2,0.8,Active Import Interval (kW),${t}`);
    rows.push(`1,2,${h >= 11 && h <= 15 ? 2 : 0},Active Export Interval (kW),${t}`);
  }
  await page.locator('.fl-upload input[type=file]').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await page.getByRole('button', { name: /Use this data/ }).click();
  const r = await page.evaluate(() => { const x = window.getRecommendation().ranked.find((y) => y.plan.export_rate > 0.15); return { exp: window.state._csv_export_kwh, rev: x.export_revenue, rate: x.plan.export_rate }; });
  expect(r.exp).toBeGreaterThan(1000);
  expect(r.rev).toBeCloseTo(r.exp * r.rate, 0);
});

test('an answer that needs the battery to charge from the grid says so, with the answer without it', async ({ page }) => {
  await fresh(page);
  await setup(page, { bill: 120, panels: 9, batt: 10 });
  const uses = await page.evaluate(() => window.sim(window.getRecommendation().best.plan.id).strategy_used);
  if (uses === 'arbitrage') {
    await expect(page.locator('.gc-note')).toContainText('charge from the grid at night');
    await expect(page.locator('.gc-note')).toContainText('If it only takes solar');
  } else {
    await expect(page.locator('.gc-note')).toHaveCount(0);
  }
  // A home without a battery never sees it.
  await fresh(page);
  await setup(page, { bill: 140, panels: 9 });
  await expect(page.locator('.gc-note')).toHaveCount(0);
});

test('storage heaters charged only overnight put more of the bill on the night rate', async ({ page }) => {
  const run = async (ht) => { await fresh(page); return page.evaluate((h) => {
    startFlow('full'); flowAnswer('bill', 'kwh:11000'); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0);
    flowAnswer('heat', 'storage'); flowAnswer('heattime', h); flowAnswer('solar', 'no'); flowAnswer('ev', 'no'); flowFinish();
    const r = window.getRecommendation(); return r.ranked.find((x) => x.plan.id === 'EI-SST').net - r.ranked.find((x) => x.plan.id === 'EI-24').net; }, ht); };
  const day = await run('day'), night = await run('night');
  expect(night).toBeLessThan(day - 50);
});

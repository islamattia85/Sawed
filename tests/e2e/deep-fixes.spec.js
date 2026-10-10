import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

const fresh = async (page) => { await isolate(page); await page.goto('/app?fresh'); await page.waitForFunction(() => window.__bootSettled === true); };
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
  await page.getByRole('button', { name: /use this data/i }).click();
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

test('setup asks where in Ireland for a solar home, and the answer changes what the panels make', async ({ page }) => {
  const gen = async (where) => { await fresh(page); return page.evaluate((w) => {
    startFlow('full'); flowAnswer('bill', 250); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0);
    flowAnswer('heat', 'gas'); flowAnswer('gas', 'no'); flowAnswer('night', 'no'); flowAnswer('solar', 'thinking');
    const asked = document.querySelector('.fl-q h2').textContent;
    flowAnswer('where', w); return { asked, region: window.state.region, kwh: window.v7SolarData ? Math.round(window.v7SolarData().cur.gen || 0) : 0, mult: window.state.region };
  }, where); };
  const s = await gen('south'), n = await gen('northwest');
  expect(s.asked).toContain('Where in Ireland');
  expect([s.region, n.region]).toEqual(['south', 'northwest']);
});

test('a meter file from a home with panels up is not given the panels twice', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Am I paying too much/ }).click();
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  for (let d = 1; d <= 28; d++) for (let h = 1; h <= 24; h++) {
    const t = `${String(d).padStart(2, '0')}-09-2026 ${String(h % 24).padStart(2, '0')}:00`;
    rows.push(`1,2,${h >= 11 && h <= 15 ? 0.1 : 0.8},Active Import Interval (kW),${t}`);
    rows.push(`1,2,${h >= 11 && h <= 15 ? 2 : 0},Active Export Interval (kW),${t}`);
  }
  await page.locator('.fl-upload input[type=file]').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await page.getByRole('button', { name: /use this data/i }).click();
  await page.evaluate(() => { flowAnswer('solar', 'have'); flowAnswer('where', 'east'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); flowAnswer('panels', 9); flowAnswer('battery', 10); });
  // The panels are in the readings: plans are priced on what was bought and
  // sold, with no panel output added on top. The home's own use, shown as its
  // two-monthly figures, is worked back once: what it bought, plus what the
  // panels made, less what it sold and a battery's losses.
  const r = await page.evaluate(() => {
    window.invalidate(); window.rebuildBase();
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const days = window.state.meter.days;
    let bought = 0, sold = 0; for (const r of Object.values(days)){ bought += sum(r.slice(0, 24)); sold += sum(r.slice(24)); }
    return { basis: window.fileBasis(), bought, sold, sep: window.state.bills['Sep-Oct'], gen: sum(Array.from(window.sim(window.state.baseline).gen)) };
  });
  expect(r.basis.mode, 'priced from the readings').toBe('net');
  expect(r.gen, 'no panel output added to readings that already have it').toBe(0);
  // Sep-Oct's use, a whole two months, is more than the file's 28 days bought scaled up, never less.
  expect(r.sep).toBeGreaterThan(r.bought / 28 * 61);
});

test('a battery that only stores solar today: its bill is read that way, and what night top-ups are worth is shown', async ({ page }) => {
  const run = (ans) => page.evaluate((ans) => {
    startFlow('full'); flowAnswer('bill', 120); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-SST'); flowAnswer('disc', 0);
    flowAnswer('heat', 'gas'); flowAnswer('night', 'no'); flowAnswer('solar', 'have'); flowAnswer('where', 'east'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); flowAnswer('panels', 9); flowAnswer('battery', 10);
    flowAnswer('gridnow', ans); flowAnswer('price', 0); flowAnswer('grant', 'no'); flowAnswer('ev', 'no'); flowFinish();
    return { kwh: Object.values(state.bills).reduce((a, b) => a + b, 0), note: !!document.querySelector('.gc-now') };
  }, ans);
  await fresh(page); const yes = await run('yes');
  await fresh(page); const no = await run('no');
  expect(no.kwh).toBeLessThan(yes.kwh);
  expect(no.note).toBe(true);
  expect(yes.note).toBe(false);
});

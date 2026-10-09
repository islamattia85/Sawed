import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

/**
 * A meter file says itself whether panels were running: an ESB smart meter
 * records every unit sent to the grid. These files are built here, a year of
 * hourly rows, to cover a file from before the panels, one with them all year,
 * one where they start partway, and a system that never exports.
 */
const fresh = async (page) => { await isolate(page); await page.goto('/app?fresh'); await page.waitForFunction(() => window.__bootSettled === true); };
function esbFile({ exportFrom = null, dropFrom = null } = {}) {
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  const start = Date.UTC(2025, 9, 6);
  for (let d = 0; d < 365; d++) {
    const date = new Date(start + d * 86400000);
    const ds = `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
    for (let h = 1; h <= 24; h++) {
      const hr = h - 1, day = hr >= 10 && hr < 16;
      const solarOn = (exportFrom !== null && d >= exportFrom) || (dropFrom !== null && d >= dropFrom);
      const imp = day && solarOn ? 0.1 : hr >= 17 && hr < 22 ? 1.4 : 0.6;
      const exp = day && exportFrom !== null && d >= exportFrom ? 1.6 : 0;
      const t = `${ds} ${String(h % 24).padStart(2, '0')}:00`;
      rows.push(`1,2,${imp * 2},Active Import Interval (kW),${t}`);
      rows.push(`1,2,${exp * 2},Active Export Interval (kW),${t}`);
    }
  }
  return { name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) };
}
const upload = async (page, file) => {
  await page.getByRole('button', { name: /Am I paying too much/ }).click();
  await page.locator('.fl-upload input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: /Use this data/ }).click();
};
const havePanels = (page) => page.evaluate(() => { flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0); flowAnswer('heat', 'heatpump'); flowAnswer('heattime', 'day'); state._flow_mode = 'full'; flowAnswer('solar', 'have'); flowAnswer('where', 'east'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); flowAnswer('panels', 10); flowAnswer('battery', 0); });
const read = (page) => page.evaluate(() => ({ basis: window.V7 ? null : null, q: document.querySelector('.fl-q h2')?.textContent || '', kwh: Object.values(state.bills).reduce((a, b) => a + b, 0) }));

test('a file from before the panels: asked, then the panels are added to it', async ({ page }) => {
  await fresh(page); await upload(page, esbFile());
  const before = await page.evaluate(() => { invalidate(); rebuildBase(); return getBestPlan().net; });
  await havePanels(page);
  await expect(page.locator('.fl-q h2')).toContainText('before the panels went up');
  await page.evaluate(() => flowAnswer('filewhen', 'before'));
  const after = await page.evaluate(() => { invalidate(); rebuildBase(); return getBestPlan().net; });
  expect(after).toBeLessThan(before - 200);
});

test('a file with the panels running all year: no question, plans priced on the readings, and the home’s own use worked back once', async ({ page }) => {
  await fresh(page); await upload(page, esbFile({ exportFrom: 0 }));
  await havePanels(page);
  await expect(page.locator('.fl-q h2')).not.toContainText('before the panels');
  const r = await page.evaluate(() => {
    invalidate(); rebuildBase();
    const rows = Object.values(state.meter.days), k = 365 / rows.length;
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const bought = sum(rows.map((r) => sum(r.slice(0, 24)))) * k;
    const s = sim(state.baseline);
    // Without the panels, the same home: its use worked back from the file.
    const without = withSimState({ has_solar: false, count_A: 0, battery_kwh: 0 }, () => sum(Array.from(sim(state.baseline).grid_import)));
    return { mode: fileBasis().mode, bought, gen: sum(Array.from(s.gen)), modelBought: sum(Array.from(s.grid_import)), without,
      used: Object.values(state.bills).reduce((a, b) => a + b, 0) };
  });
  // The panels are in the readings: what each plan charges is what the meter recorded, nothing added on top.
  expect(r.mode).toBe('net');
  expect(r.gen).toBe(0);
  expect(Math.abs(r.modelBought - r.bought) / r.bought, JSON.stringify(r)).toBeLessThan(0.02);
  // The home used more than it bought (the panels covered some), counted once.
  expect(r.used, JSON.stringify(r)).toBeGreaterThan(r.bought * 1.02);
  expect(r.without, JSON.stringify(r)).toBeGreaterThan(r.bought * 1.02);
  expect(r.without, JSON.stringify(r)).toBeLessThan(r.used * 1.1);
});

test('panels that start partway through: the part before them is the home’s usage', async ({ page }) => {
  await fresh(page); await upload(page, esbFile({ exportFrom: 250 }));
  await havePanels(page);
  const r = await page.evaluate(() => ({ kwh: Object.values(state.bills).reduce((a, b) => a + b, 0), sum: window.fileSummaryText ? '' : '' }));
  // Before the panels the home buys 0.6-1.4 kWh every hour: about 6,600 kWh a year.
  expect(r.kwh).toBeGreaterThan(6000);
});

test('a system that never exports: the daytime drop is spotted and asked about', async ({ page }) => {
  await fresh(page); await upload(page, esbFile({ dropFrom: 200 }));
  await havePanels(page);
  await expect(page.locator('.fl-q h2')).toContainText('Did the panels go up around');
});

test('a typed summer bill after the panels widens the accuracy range', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    startFlow('full'); flowAnswer('bill', 40); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0);
    flowAnswer('heat', 'heatpump'); flowAnswer('heattime', 'day'); flowAnswer('solar', 'have'); flowAnswer('where', 'east'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); flowAnswer('panels', 10); flowAnswer('battery', 0);
    const asked = document.querySelector('.fl-q h2')?.textContent || '';
    flowAnswer('billwhen', 'after'); flowAnswer('billmonths', 'summer');
    const summer = Object.values(state.bills).reduce((a, b) => a + b, 0);
    flowAnswer('billmonths', 'average');
    const avg = Object.values(state.bills).reduce((a, b) => a + b, 0);
    flowAnswer('billmonths', 'summer');
    return { asked, summer, avg };
  });
  expect(r.asked).toContain('before or after the panels');
  // The same EUR 40 is a far bigger home if it is a summer bill after solar.
  expect(r.summer).toBeGreaterThan(r.avg);
  await page.evaluate(() => { flowAnswer('price', 0); flowAnswer('grant', 'no'); flowAnswer('ev', 'no'); flowFinish(); anTab('accuracy'); });
  await expect(page.locator('.ax-acc', { hasText: 'Your usage' })).toContainText('±15%');
});

test('ESB’s daily files are recognised and the right download is named', async ({ page }) => {
  for (const [type, want] of [['Active Import Daily Max Demand (kW)', 'highest-demand'], ['Active Import Register Day (kWh)', 'daily files']]) {
    await fresh(page);
    await page.getByRole('button', { name: /Am I paying too much/ }).click();
    const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
    for (let d = 1; d <= 28; d++) rows.push(`1,2,${1000 + d * 10},${type},${String(d).padStart(2, '0')}-09-2026 00:00`);
    await page.locator('.fl-upload input[type=file]').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
    await expect(page.locator('body')).toContainText(want);
    await expect(page.locator('body')).toContainText('30-minute readings in kW');
  }
});

test('a meter file that already has the car is priced as it is: saying "I have an EV" does not move the bill', async ({ page }) => {
  // A year with the car charging 2am to 5am, as an owner's file shows it.
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  const start = Date.UTC(2025, 9, 6);
  for (let d = 0; d < 365; d++) {
    const date = new Date(start + d * 86400000);
    const ds = `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
    for (let h = 1; h <= 24; h++) {
      const hr = h - 1, imp = hr >= 2 && hr < 5 ? 3.3 : hr >= 17 && hr < 22 ? 0.9 : 0.5;
      rows.push(`1,2,${imp * 2},Active Import Interval (kW),${ds} ${String(h % 24).padStart(2, '0')}:00`);
      rows.push(`1,2,0,Active Export Interval (kW),${ds} ${String(h % 24).padStart(2, '0')}:00`);
    }
  }
  await fresh(page); await upload(page, { name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  const cost = () => page.evaluate(() => { invalidate(); rebuildBase(); const p = getPlanById('EI-NB'); return Math.round(annualCost(sim(p.id), p).net); });
  const without = await cost();
  await page.evaluate(() => { state.ev_active = true; state.ev_in_bill = true; state.ev_km_per_year = 15000; });
  const withCar = await cost();
  expect(Math.abs(withCar - without), `the file already holds the car: ${without} vs ${withCar}`).toBeLessThanOrEqual(2);
});

// @ts-check
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/*
 * A car on Home is charged at home: "Leave out" takes it out, and that is the
 * only switch. An old meter file, from before the car, is the normal case: the
 * car goes on top, from the person's own distance, as panels go on top of a
 * file from before them. The one thing to avoid is counting it twice when the
 * file was recorded with the car; the readings show that (12 Oct 2026).
 */
const HOME = { current_screen: 'result', region: 'south', heating_type: 'heatpump', usage_input_mode: 'kwh', annual_kwh: 6000,
  baseline: 'EN-EV', baseline_known: true, meter_type: 'smart', has_solar: false, considering_solar: false, count_A: 0, count_B: 0,
  battery_kwh: 0, ev_active: true, ev_in_bill: true, ev_km_per_year: 15000 };

/** A year of readings, as the importer leaves it: the car's charging in them,
 *  or (withCar false) the home without it; nightKwh adds a battery filling from
 *  the grid at that many kWh an hour, 2am to 5am. */
const giveFile = ([withCar, nightKwh] = [true, 0]) => {
  const s = /** @type {any} */ (window);
  s.rebuildBase();
  const cons = Array.from(withCar ? s.CACHE.cons : s.CACHE.consNoEv), days = {};
  for (let i = 0; i < 365; i++){
    const k = new Date(Date.UTC(2025, 9, 1 + i)).toISOString().slice(0, 10), row = new Array(48).fill(0);
    const doy = (i + 273) % 365;
    for (let h = 0; h < 24; h++) row[h] = +(cons[doy * 24 + h] + (h >= 2 && h < 5 ? nightKwh : 0)).toFixed(3);
    days[k] = row;
  }
  Object.assign(s.state, { meter: { days }, _csv_imported: true, usage_input_mode: 'csv' });
  s.invalidate(); s.saveState(); s.setScreen('result');
};
const figures = () => { const s = /** @type {any} */ (window), r = s.getRecommendation(); return { now: Math.round(r.baseCost), best: Math.round(r.best.net) }; };

test('a car whose charging is in the meter file is in every figure: no "Leave out", and one left out comes back', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, HOME);
  await page.evaluate(giveFile);
  const withCar = await page.evaluate(figures);

  // Home: the car's line says why it stays, and offers no switch.
  const row = page.locator('.v7-hero .v7-ev-ctl');
  await expect(row).toContainText('in your meter readings');
  await expect(row.locator('button', { hasText: 'Leave out' })).toHaveCount(0);
  // Nor does the Car tab, and the switch itself refuses.
  await page.evaluate(() => /** @type {any} */ (window).anTab('car'));
  await expect(page.locator('body')).not.toContainText('Leave the car out of the figures');
  await page.evaluate(() => /** @type {any} */ (window).toggleEvModel());
  expect(await page.evaluate(() => /** @type {any} */ (window).state.ev_active)).toBe(true);

  // A save from before, with the car left out: it comes back, figures as they were.
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('solarAppState_v2') || '{}');
    localStorage.setItem('solarAppState_v2', JSON.stringify({ ...s, ev_active: false, _ev_left_out: true, current_screen: 'result' })); });
  await page.reload();
  await page.waitForFunction(() => /** @type {any} */ (window).__bootSettled === true, null, { timeout: 10_000 });
  expect(await page.evaluate(() => { const s = /** @type {any} */ (window).state; return [s.ev_active, s._ev_left_out]; })).toEqual([true, undefined]);
  await page.evaluate(() => /** @type {any} */ (window).setScreen('result'));
  await expect(page.locator('.hc-invite', { hasText: 'left out' })).toHaveCount(0);
  await expect(page.locator('.v7-hero .v7-ev-ctl')).toBeVisible();
  expect(await page.evaluate(figures)).toEqual(withCar);
});

test('a car with no meter file can still be left out, and that changes the figures', async ({ page }) => {
  await boot(page, HOME);
  const withCar = await page.evaluate(figures);
  await expect(page.locator('.v7-hero .v7-ev-ctl button', { hasText: 'Leave out' })).toBeVisible();
  await page.locator('.v7-hero .v7-ev-ctl button').click();
  const without = await page.evaluate(figures);
  expect(without.now).toBeLessThan(withCar.now - 100);
});

// The owner's own file (Jun 2025 to May 2026) is from before the car. The app
// took the car as in it and left its charging out of every figure; for a few
// hours it then asked whether it charged at home. Nothing is asked now.
test('a meter file from before the car: its charging goes on top, nothing is asked, and "Leave out" takes it out', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, HOME);
  const typed = await page.evaluate(figures);   // the same home and car, typed in
  await page.evaluate(giveFile, [false, 0]);
  const row = page.locator('.v7-hero .v7-ev-ctl');
  await expect(row).toContainText('Added on top of your meter readings.');
  await expect(row).not.toContainText('?');
  const added = await page.evaluate(figures);
  expect(Math.abs(added.now - typed.now), `${added.now} against ${typed.now}`).toBeLessThan(typed.now * 0.03);
  await row.locator('button', { hasText: 'Leave out' }).click();
  const without = await page.evaluate(figures);
  expect(without.now).toBeLessThan(added.now - 100);
  await page.locator('.hc-invite', { hasText: 'left out' }).click();
  expect((await page.evaluate(figures)).now).toBe(added.now);
});

test('a battery that filled from the grid at night while the file was recorded is not taken for the car', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, { ...HOME, battery_kwh: 9, battery_charge_kw: 3 });
  await page.evaluate(giveFile, [false, 3]);
  await expect(page.locator('.v7-hero .v7-ev-ctl')).toContainText('Added on top of your meter readings.');
});

/* Asked once, where the file and the car meet: in setup, in the car guide,
 * and on the file's card when the car came first. */
function esbFile() {
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  const start = Date.UTC(2025, 5, 1);
  for (let d = 0; d < 365; d++) {
    const date = new Date(start + d * 86400000);
    const ds = `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
    for (let h = 1; h <= 24; h++) {
      const hr = h - 1, imp = hr >= 17 && hr < 22 ? 1.4 : 0.6;
      rows.push(`1,2,${imp * 2},Active Import Interval (kW),${ds} ${String(h % 24).padStart(2, '0')}:00`);
    }
  }
  return { name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) };
}
const toQuestion = (page, stop, answers) => page.evaluate(([stop, ans]) => {
  for (let i = 0; i < 40; i++) {
    const sec = document.querySelector('.fl-q'), el = sec && sec.querySelector('[data-q]');
    const m = !el && sec && sec.innerHTML.match(/flowAnswer\('(\w+)'/), q = el ? el.dataset.q : m ? m[1] : null;
    if (!q || q === stop) return q;
    window.flowAnswer(q, ans[q] ?? 'no');
  }
  return null;
}, [stop, answers]);

test('setup: a meter file and "I have one" asks once whether the car is in the file, with the file’s months', async ({ page }) => {
  await boot(page, { ev_active: false, ev_in_bill: false });
  await page.evaluate(() => /** @type {any} */ (window).startFlow('full'));
  await page.locator('.fl-upload input[type=file]').setInputFiles(esbFile());
  await page.getByRole('button', { name: /use this data/i }).click();
  const q = await toQuestion(page, 'evfile', { meter: 'smart', area: 'urban', plan: 'EI-24', disc: 0, heat: 'gas', gas: 'no', solar: 'no', ev: 'have' });
  expect(q).toBe('evfile');
  await expect(page.locator('.fl-q')).toContainText('Is the car’s charging in your ESB file?');
  await expect(page.locator('.fl-q')).toContainText('May 2025 to May 2026');
  await page.evaluate(() => /** @type {any} */ (window).flowAnswer('evfile', 'no'));
  expect(await page.evaluate(() => /** @type {any} */ (window).state.ev_in_file)).toBe(false);
  expect(await toQuestion(page, 'km', {})).toBe('km');
});

test('the car guide, with a meter file: "I got it after my ESB file" puts it on top', async ({ page }) => {
  await boot(page, { ...HOME, ev_active: false, ev_in_bill: false });
  await page.evaluate(giveFile, [false, 0]);
  await page.evaluate(() => /** @type {any} */ (window).startEvGuide());
  await expect(page.getByRole('button', { name: /Yes, and it’s in my ESB file/ })).toBeVisible();
  await page.getByRole('button', { name: /Yes, I got it after my ESB file/ }).click();
  const s = await page.evaluate(() => { const st = /** @type {any} */ (window).state; return [st.ev_in_file, st.ev_in_bill, st._eg]; });
  expect(s).toEqual([false, true, 2]);
});

test('a meter file added after the car: its card asks, and the answer sticks', async ({ page }) => {
  await boot(page, HOME);
  await page.evaluate(() => /** @type {any} */ (window).startFlow('full'));
  await page.locator('.fl-upload input[type=file]').setInputFiles(esbFile());
  const ask = page.locator('[data-ask="car"]');
  await expect(ask).toContainText('Is your car’s charging in this file?');
  await expect(ask).toContainText('May 2025 to May 2026');
  await ask.locator('[data-car-in="no"]').click();
  await expect(ask.locator('[data-car-in="no"]')).toHaveClass(/on/);
  expect(await page.evaluate(() => /** @type {any} */ (window).state.ev_in_file)).toBe(false);
  await page.getByRole('button', { name: /use this data/i }).click();
  expect(await page.evaluate(() => /** @type {any} */ (window).state.ev_in_file)).toBe(false);
});

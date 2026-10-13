// @ts-check
import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

/*
 * Section 1 of the 13 October direction: what a tester meets in the first
 * five minutes. Each test walks in the way a stranger would.
 */
const fresh = async (page) => {
  await isolate(page);
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true || !!document.querySelector('.wl-journey'));
};
/** Answers setup's questions from `ans` until it ends (or reaches `stop`). */
const answer = (page, ans, stop) => page.evaluate(([ans, stop]) => {
  const W = /** @type {any} */ (window);
  for (let i = 0; i < 40; i++) {
    const sec = document.querySelector('.fl-q'), el = sec && sec.querySelector('[data-q]');
    const m = !el && sec && sec.innerHTML.match(/flowAnswer\('(\w+)'/), q = el ? el.dataset.q : m ? m[1] : null;
    if (q && q === stop) return q;
    if (!q) { if (document.querySelector('.fl-go')) W.flowFinish(); return null; }
    W.flowAnswer(q, ans[q] ?? 'no');
  }
  return null;
}, [ans, stop]);
// The typical home the regulator uses: 4,200 kWh a year, gas heating, a smart meter, Electric Ireland.
const TYPICAL = { bill: 'kwh:4200', meter: 'smart', area: 'urban', plan: 'guess:EI-24', heat: 'gas', gas: 'no', night: 'no' };

test('1.1 a gas home from "Just a better plan" that taps Plan solar sees planned panels, never "your solar"', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Just a better plan/ }).click();
  await answer(page, { ...TYPICAL, switched: 'longer' });
  await page.evaluate(() => /** @type {any} */ (window).setScreen('profile'));
  await page.getByRole('button', { name: /Plan solar/ }).first().click();
  await expect(page.locator('#v7-sheet .sy-status .on')).toHaveText('Planning it');
  await page.evaluate(() => { const W = /** @type {any} */ (window); W.v7Sheet(null); W.setScreen('result'); });
  const home = page.locator('#app-root');
  await expect(home).toContainText('planned panels');
  await expect(home).not.toContainText(/your solar/i);
});

test('1.2 the typical gas home on Electric Ireland, not switched in years: its standard plan is "Now", the saving is in the hundreds, and the assumption is said', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Just a better plan/ }).click();
  expect(await answer(page, TYPICAL, 'switched')).toBe('switched');
  await expect(page.locator('.fl-q')).toContainText('When did you last switch supplier or sign up to a plan?');
  await answer(page, { ...TYPICAL, switched: 'longer' });
  const st = await page.evaluate(() => { const s = /** @type {any} */ (window).state; return [s.baseline, s.last_switched, s.baseline_known]; });
  expect(st).toEqual(['EI-STD-24', 'longer', false]);
  await page.evaluate(() => /** @type {any} */ (window).setScreen('result'));
  await expect(page.locator('#app-root')).toContainText('Now, on Electric Ireland’s standard plan (assumed; change it if you know your plan)');
  const saving = await page.evaluate(() => { const r = /** @type {any} */ (window).getRecommendation(); return r.annualSavings; });
  expect(saving).toBeGreaterThanOrEqual(100);
});

test('1.2 switched within the last year keeps the supplier’s discounted plan; a supplier with no standard rates says so', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Just a better plan/ }).click();
  await answer(page, { ...TYPICAL, switched: 'year' });
  expect(await page.evaluate(() => /** @type {any} */ (window).state.baseline)).toBe('EI-24');
  // Yuno publishes no standard rates: its discounted plan, said as such.
  await fresh(page);
  await page.getByRole('button', { name: /Just a better plan/ }).click();
  await answer(page, { ...TYPICAL, plan: 'guess:YN-24', switched: 'longer' });
  expect(await page.evaluate(() => /** @type {any} */ (window).state.baseline)).toBe('YN-24');
  await page.evaluate(() => /** @type {any} */ (window).setScreen('result'));
  await expect(page.locator('#app-root')).toContainText('Yuno Energy publishes no standard rates');
});

test('1.2 the standard plans are kept out of Plans and every count; each supplier with published standard rates has one', async ({ page }) => {
  await fresh(page);
  const r = await page.evaluate(() => {
    const W = /** @type {any} */ (window), T = W.TARIFFS;
    return { assumedOnly: T.filter((p) => p.assumed_only).map((p) => p.id), ranked: W.getRecommendation().ranked.map((x) => x.plan.id) };
  });
  expect(r.assumedOnly.length).toBe(8);
  for (const id of r.assumedOnly) expect(r.ranked).not.toContain(id);
});

test('1.3 one plan count: Home, Plans and the front page agree for the home’s meter', async ({ page }) => {
  await fresh(page);
  const lede = await page.locator('.wl-lede').first().textContent();
  await page.getByRole('button', { name: /Just a better plan/ }).click();
  await answer(page, { ...TYPICAL, switched: 'longer' });
  const c = await page.evaluate(() => /** @type {any} */ (window).planCount());
  expect(c.label).toBe(`${c.n} plans for a smart meter`);
  expect(lede).toContain(`${c.n} of them for smart meters`);
  // Every count on Home, Analytics and Updates is the same one.
  for (const scr of ['result', 'analytics', 'updates']) {
    await page.evaluate((s) => /** @type {any} */ (window).setScreen(s), scr);
    const text = await page.locator('#app-root').innerText();
    for (const m of text.matchAll(/(\d+) plans\b/g)) expect(+m[1], `${scr}: "${m[0]}"`).toBe(c.n);
  }
  await page.evaluate(() => /** @type {any} */ (window).setScreen('plans'));
  await expect(page.locator('.v7-page-head')).toContainText(c.label);
  await expect(page.locator('.plan-filter-pill').first().locator('.count')).toHaveText(String(c.n));
});

test('1.4 audit notes never show; a plan’s public note does. 1.7 the sheet gives the contract and exit fee', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Just a better plan/ }).click();
  await answer(page, { ...TYPICAL, switched: 'longer' });
  const W = (f, a) => page.evaluate(f, a);
  const notes = await W((id) => /** @type {any} */ (window).getPlanById(id).notes, 'EI-24');
  expect(notes.length).toBeGreaterThan(20);
  // The full rate card and the plan sheet: none of the audit note.
  await W(() => /** @type {any} */ (window).showPlanDetail('EI-24'));
  await expect(page.locator('body')).not.toContainText(notes.slice(0, 40));
  await W(() => { document.querySelectorAll('.modal-overlay, #plan-detail').forEach((e) => e.remove()); /** @type {any} */ (window).v7Sheet('plan', 'EI-24'); });
  await expect(page.locator('#v7-sheet')).not.toContainText(notes.slice(0, 40));
  await expect(page.locator('#v7-sheet .v7-terms')).toHaveText('12-month contract · €50 exit fee');
  // A standard plan: no contract to show, and its public note.
  await W(() => /** @type {any} */ (window).v7Sheet('plan', 'EI-STD-24'));
  await expect(page.locator('#v7-sheet .v7-terms')).toHaveCount(0);
  await expect(page.locator('#v7-sheet')).toContainText('where most customers end up when a discount runs out');
});

test('1.5 a reload opens no sheet; the meter sheet shows the file that is in, with Replace the file', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: /Just a better plan/ }).click();
  await answer(page, { ...TYPICAL, switched: 'longer' });
  // A year of readings, as the importer leaves them.
  await page.evaluate(() => {
    const W = /** @type {any} */ (window), days = {};
    for (let i = 0; i < 365; i++) { const k = new Date(Date.UTC(2025, 5, 1 + i)).toISOString().slice(0, 10); days[k] = Array(24).fill(0.5).concat(Array(24).fill(0)); }
    Object.assign(W.state, { meter: { days }, _csv_imported: true, usage_input_mode: 'csv', _csv_export_kwh: 0 });
    W.invalidate(); W.saveState(); W.setScreen('result'); W.v7Sheet('meter');
  });
  const sheet = page.locator('#v7-sheet');
  await expect(sheet).toContainText('Your ESB file is in');
  await expect(sheet).toContainText('1 June 2025 to 31 May 2026');
  await expect(sheet).toContainText('None in the file');
  // A reload, or a return days later, opens Home, not the sheet.
  await page.evaluate(() => /** @type {any} */ (window).saveState());
  expect(await page.evaluate(() => 'sheet' in JSON.parse(localStorage.getItem('solarAppState_v2') || '{}') || '_sheet' in JSON.parse(localStorage.getItem('solarAppState_v2') || '{}'))).toBe(false);
  await page.reload();
  await page.waitForFunction(() => /** @type {any} */ (window).__bootSettled === true);
  await expect(page.locator('#v7-sheet')).toHaveCount(0);
  await page.evaluate(() => /** @type {any} */ (window).v7Sheet('meter'));
  await page.getByRole('button', { name: /Replace the file/ }).click();
  await expect(page.locator('#v7-sheet')).toContainText('Choose the file');
});

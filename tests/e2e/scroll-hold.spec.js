import { test, expect } from '@playwright/test';
import { boot } from './support.js';
// Safari has no scroll anchoring: a redraw or a list filling in above the
// reader pushed the page and it jumped. The control being used must stay put.
test('editing never moves the control you are using, even without scroll anchoring', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, { baseline: 'EI-24', has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 9, current_screen: 'result' });
  await page.addStyleTag({ content: '* { overflow-anchor: none !important; }' });   // as Safari: no scroll anchoring
  const track = async (label, setup, sel, act) => {
    await page.evaluate(setup); await page.waitForTimeout(1500);
    await page.evaluate((sel) => { window.__trace = []; window.__iv = setInterval(() => { const e = document.querySelector(sel); window.__trace.push(e ? Math.round(e.getBoundingClientRect().top) : null); }, 40); }, sel);
    await page.evaluate(act); await page.waitForTimeout(2500);
    const tr = await page.evaluate(() => { clearInterval(window.__iv); return window.__trace; });
    const changes = tr.filter((x, i) => i && x !== tr[i - 1]);
    expect(Math.max(0, ...tr.filter((v) => v != null).map((v) => Math.abs(v - tr[0]))), `${label}: ${JSON.stringify(changes)}`).toBeLessThanOrEqual(2);
  };
  await track('my system slider', () => { openMySystem(); setTimeout(() => { document.getElementById('sy-cA').scrollIntoView({ block: 'center' }); }, 300); }, '#sy-cA',
    () => { const el = document.getElementById('sy-cA'); el.value = 14; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await track('my system battery', () => {}, '#sy-cA',
    () => { const b = [...document.querySelectorAll('#v7-sheet button')].find((x) => /^\s*13/.test(x.textContent)); b && b.click(); });
  await track('my home heating', () => { v7Sheet(null); openMyHome(); setTimeout(() => document.querySelector('#v7-sheet select').scrollIntoView({ block: 'center' }), 300); }, '#v7-sheet select',
    () => homeSet('heating_type', 'heatpump'));
  await track('my system quick change (undo bar appears)', () => { v7Sheet(null); openMySystem(); setTimeout(() => document.getElementById('sy-cA').scrollIntoView({ block: 'center' }), 300); }, '#sy-cA',
    () => { const el = document.getElementById('sy-cA'); el.value = 11; el.dispatchEvent(new Event('change', { bubbles: true })); undoLast(); const e2 = document.getElementById('sy-cA'); e2.value = 12; e2.dispatchEvent(new Event('change', { bubbles: true })); });
  await track('home: use a system (undo bar on page)', () => { v7Sheet(null); setScreen('result'); setTimeout(() => scrollTo(0, 600), 300); }, '.v7-basis-line',
    () => { openQuickSystem(); qsStep('a', 1); qsApply(); });
  await track('solar tab quick change', () => { v7Sheet(null); setScreen('analytics'); anTab('solar'); setTimeout(() => document.querySelector('.v7-system').scrollIntoView({ block: 'center' }), 300); }, '.v7-system',
    () => { openQuickSystem(); qsStep('a', 1); qsApply(); });
});

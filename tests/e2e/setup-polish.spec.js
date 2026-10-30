import { test, expect } from '@playwright/test';
import { isolate, esbKwFile } from './support.js';

/**
 * Setup and small things from the user test of 30 Oct 2026: the app's row of
 * answers ran to six lines by the car questions, the summary said "ev" and
 * told an oil home it had "Gas with another supplier", the bill box and a big
 * Next stayed above a meter file's own "Yes, use this data", the pencils were
 * 18px to tap, and "Report downloaded" sat above a stale "Preparing your report".
 */
const ANS = { bill: 180, plan: 'EI-24', disc: 0, meter: 'smart', area: 'urban', heat: 'gas', gas: 'no', night: 'no', switched: 'longer', solar: 'no', ev: 'have', km: 16000, car: 17 };

const start = async (page, path, route = 'full') => {
  await isolate(page);
  await page.goto(`${path}?fresh`);
  await page.waitForFunction(() => window.__bootSettled === true);
  await page.evaluate((r) => window.startFlow(r), route);
};
const answerUntil = (page, stop) => page.evaluate(([stop, ans]) => {
  for (let i = 0; i < 40; i++) {
    const sec = document.querySelector('.fl-q'), el = sec && sec.querySelector('[data-q]');
    const m = !el && sec && sec.innerHTML.match(/flowAnswer\('(\w+)'/), q = el ? el.dataset.q : m ? m[1] : null;
    if (!q || q === stop) return q;
    window.flowAnswer(q, ans[q] ?? 'no');
  }
  return null;
}, [stop, ANS]);

test('the app: past four answers the row folds to the last three and one chip for the rest', async ({ page }) => {
  await start(page, '/app');
  expect(await answerUntil(page, 'km')).toBe('km');
  const chips = page.locator('.fl-chip');
  const more = page.locator('.fl-chip-more');
  await expect(more).toHaveText(/^\d+ more answers$/);
  const hidden = +(await more.textContent()).match(/\d+/)[0];
  await expect(chips).toHaveCount(4);
  // The question starts within the first screen of a small phone.
  const top = await page.locator('.fl-q h2').evaluate((h) => h.getBoundingClientRect().top);
  expect(top).toBeLessThan(400);
  await more.click();
  await expect(chips).toHaveCount(hidden + 3);
  await expect(page.locator('.fl-chip', { hasText: 'Gas elsewhere, or oil' })).toHaveCount(1);
});

test('the website: the summary names the car and an oil home, and its pencils are big enough to tap', async ({ page }) => {
  await start(page, '/');
  expect(await answerUntil(page, 'km')).toBe('km');
  const sofar = page.locator('.fl-sofar');
  await expect(sofar.locator('> div', { hasText: /^Electric car/ })).toHaveCount(1);
  await expect(sofar).not.toContainText(/^ev/m);
  await expect(sofar).toContainText('Gas elsewhere, or oil');
  const small = await sofar.locator('button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width < 24 || r.height < 24).length);
  expect(small).toBe(0);
});

test('a meter file read in setup: its own "Yes, use this data" is the only way on', async ({ page }) => {
  await start(page, '/');
  await expect(page.locator('.fl-bill')).toBeVisible();
  await page.locator('.fl-upload input[type=file]').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(esbKwFile('2026-09-30', 365)) });
  await expect(page.getByRole('button', { name: /use this data/i })).toBeVisible();
  await expect(page.locator('.fl-bill')).toBeHidden();
  await expect(page.locator('.fl-q .fl-next')).toBeHidden();
});

test('the report: "Report downloaded" replaces "Preparing your report", it doesn\'t sit under it', async ({ page }) => {
  test.setTimeout(90000);
  await start(page, '/', 'quick');
  await answerUntil(page, null);
  await page.evaluate(() => { window.flowFinish(); window.setScreen('result'); });
  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  await download;
  await expect(page.locator('.toast', { hasText: /Report downloaded|Report ready|Report opened/ })).toHaveCount(1);
  await expect(page.locator('.toast', { hasText: 'Preparing your report' })).toHaveCount(0);
});

import { test, expect } from '@playwright/test';
import { isolate, esbKwFile } from './support.js';

/**
 * Usage counts (29 Oct 2026): how far people get, sent to our own server only
 * after a yes to the usage question. The steps were counted only for
 * analytics tools the app doesn't load, so nobody could see how many people
 * got through setup.
 */
const ANS = { plan: 'EI-24', disc: 0, meter: 'smart', area: 'urban', heat: 'gas', gas: 'no', night: 'no', solar: 'no', ev: 'no' };

/** Setup from the start with a meter file, to the answer; then the report, a copied result and the plans. */
async function useTheApp(page, consent) {
  const sent = [];
  await isolate(page);
  await page.route('**/api/event', async (r) => { sent.push(r.request().postDataJSON()); await r.fulfill({ status: 200, json: { ok: true } }); });
  await page.goto('/?fresh');
  await page.waitForFunction(() => window.__bootSettled === true);
  await page.evaluate((c) => localStorage.setItem('sawed_analytics', c), consent);
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true);
  await page.evaluate(() => window.startFlow('full'));
  await page.locator('.fl-upload input[type=file]').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv',
    buffer: Buffer.from(esbKwFile('2026-09-30', 365)) });
  await page.getByRole('button', { name: /use this data/i }).click();
  await page.evaluate((ans) => {
    for (let i = 0; i < 40; i++) {
      const sec = document.querySelector('.fl-q'), el = sec && sec.querySelector('[data-q]');
      const m = !el && sec && sec.innerHTML.match(/flowAnswer\('(\w+)'/), q = el ? el.dataset.q : m ? m[1] : null;
      if (!q) break;
      window.flowAnswer(q, ans[q] ?? 'no');
    }
    window.flowFinish();
  }, ANS);
  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  await download;
  await page.evaluate(() => { window.shareSavingsCard(); });
  await page.getByRole('button', { name: 'Copy as text' }).click();
  await page.evaluate(() => window.setScreen('plans'));
  await page.waitForTimeout(500);
  return sent;
}

test('with a yes: setup, the meter file, the report, a share and the screens are counted, and nothing about the home goes with them', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const sent = await useTheApp(page, 'yes');
  const names = sent.map((e) => e.name);
  for (const step of ['setup_started', 'meter_file_added', 'setup_finished', 'report_downloaded', 'result_shared', 'screen_viewed']) {
    expect(names, step).toContain(step);
  }
  // One visit, one random number, the same on every count.
  expect(new Set(sent.map((e) => e.session_id)).size).toBe(1);
  expect(sent[0].session_id).toMatch(/^[0-9a-f-]{8,}$/);
  expect(sent.find((e) => e.name === 'setup_finished').props).toEqual({ route: 'full', solar: 'none', ev: false, meter_file: true });
  expect(sent.find((e) => e.name === 'result_shared').props).toEqual({ how: 'text', details: true });
  expect(sent.find((e) => e.name === 'screen_viewed' && e.props.screen === 'plans')).toBeTruthy();
  // No amount, place or answer in any of them.
  expect(JSON.stringify(sent)).not.toMatch(/region|bill|kwh|county|eur|EI-24|urban|smart/i);
});

test('with a no: nothing is sent', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const sent = await useTheApp(page, 'no');
  expect(sent).toEqual([]);
});

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isolate } from './support.js';

/**
 * One rule for a switch worth making (30 Oct 2026). In the user test, a home
 * whose cheapest plan was €17 a year less was told "€17 less a year by
 * switching" at the end of setup, "Your plan is already the best value.
 * Nothing on sale costs less" on Home one tap later, "Save €17/yr by
 * switching" on the report sheet, and "Switch to …" in the report. Every
 * screen now uses the same rule (€20 a year) and, under it, the same words.
 */
const ANS = { bill: 180, plan: 'EI-24', disc: 0, meter: 'smart', area: 'urban', heat: 'gas', gas: 'no', night: 'no', switched: 'longer' };

/** The quick check, on the website, answered to the end: the answer is on screen. */
async function quickCheck(page, plan) {
  await page.goto('/?fresh');
  await page.waitForFunction(() => window.__bootSettled === true);
  await page.evaluate(() => window.startFlow('quick'));
  await page.evaluate((ans) => {
    for (let i = 0; i < 40; i++) {
      const sec = document.querySelector('.fl-q'), el = sec && sec.querySelector('[data-q]');
      const m = !el && sec && sec.innerHTML.match(/flowAnswer\('(\w+)'/), q = el ? el.dataset.q : m ? m[1] : null;
      if (!q) break;
      window.flowAnswer(q, ans[q] ?? 'no');
    }
  }, { ...ANS, plan });
  await expect(page.locator('.fl-reveal')).toBeVisible();
  return page.evaluate(() => {
    const rec = window.getRecommendation();
    return { saving: Math.round(rec.baseCost - rec.best.net), ranked: rec.ranked.map((r) => ({ id: r.plan.id, gap: Math.round(r.net - rec.best.net) })) };
  });
}

/** A plan this home could be on whose cheapest alternative is within `lo`–`hi` a year, so the test holds as prices move. */
async function homeSaving(page, lo, hi) {
  let r = await quickCheck(page, ANS.plan);
  if (r.saving < lo || r.saving >= hi) {
    const p = r.ranked.find((x) => x.gap >= lo && x.gap < hi);
    expect(p, `a plan ${lo}–${hi} a year dearer than the cheapest`).toBeTruthy();
    r = await quickCheck(page, p.id);
  }
  expect(r.saving).toBeGreaterThanOrEqual(lo);
  expect(r.saving).toBeLessThan(hi);
  return r.saving;
}

test.describe('a cheaper plan that is not worth a switch', () => {
  // The service worker would serve the report's typeface past the block below.
  test.use({ serviceWorkers: 'block' });

  test('every screen says the plan is as good as any, and names what a switch would save', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await isolate(page);
    const save = await homeSaving(page, 2, 20);
    const reveal = page.locator('.fl-reveal');
    await expect(reveal).toContainText('already on a good plan');
    await expect(reveal).toContainText(`would save only €${save} a year: not worth a switch`);
    await expect(reveal).not.toContainText('less a year');

    await page.evaluate(() => { window.flowFinish(); window.setScreen('result'); });
    await expect(page.locator('.web-page-head .web-title')).toHaveText('Your plan is as good as any.');
    await expect(page.locator('.web-page-head')).not.toContainText('Nothing on sale costs less');
    await expect(page.locator('.v7-headline').first()).toContainText('not worth a switch');

    await page.evaluate(() => window.openPdfReportModal());
    await expect(page.locator('#pdf-modal')).toContainText('Your plan is as good as any');
    await expect(page.locator('#pdf-modal')).not.toContainText('by switching');
    await page.evaluate(() => window.closePdfModal());

    const share = await page.evaluate(() => window.__shareText(false));
    expect(share).toContain(`my plan is as good as any. A switch would save €${save} a year at most`);

    // The report, in its own faces so its words can be read from the file.
    await page.route('**/assets/fonts-*.js', (r) => r.abort());
    const download = page.waitForEvent('download', { timeout: 45_000 });
    await page.evaluate(() => window.doGeneratePdf(''));
    const path = testInfo.outputPath('report.pdf');
    await (await download).saveAs(path);
    const raw = readFileSync(path).toString('latin1');
    expect(raw).toContain('YOUR PLAN IS AS GOOD AS ANY');
    // The line wraps after the figure.
    expect(raw).toMatch(new RegExp(`Stay on your plan: the cheapest, [^)]*would save only \\x80${save}\\b`));
    expect(raw).not.toMatch(/a year less than now/);
  });
});

test('a saving over the line still reads as a switch on every screen', async ({ page }) => {
  test.setTimeout(90000);
  await isolate(page);
  const save = await homeSaving(page, 25, 400);
  await expect(page.locator('.fl-reveal')).toContainText(`€${save.toLocaleString('en-IE')} less a year`);
  await page.evaluate(() => { window.flowFinish(); window.setScreen('result'); });
  await expect(page.locator('.web-page-head .web-title')).toContainText(`less a year`);
  await page.evaluate(() => window.openPdfReportModal());
  await expect(page.locator('#pdf-modal')).toContainText('by switching to');
  expect(await page.evaluate(() => window.__shareText(false))).toMatch(/a year less\./);
});

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot } from './support.js';

/**
 * The unit suite renders the report from fixed data. This drives the real app
 * end to end, which is the only way to catch the failure mode that actually
 * shipped: a value the live engine produces that the fixtures never contained.
 *
 * A NaN cost from one mis-shaped tariff crashed the generator here while every
 * unit test stayed green, because JSON round-tripping the captured data had
 * silently turned that NaN into null.
 */

test('generates a real PDF from live app state', async ({ page }, testInfo) => {
  const errors = await boot(page, { ev_active: true, ev_km_per_year: 16500 });

  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  const file = await download;

  // A silent fall back to the plain-text summary means generation threw.
  expect(file.suggestedFilename(), 'fell back to the text report — PDF generation threw')
    .toMatch(/\.pdf$/);

  const path = testInfo.outputPath('report.pdf');
  await file.saveAs(path);
  const bytes = readFileSync(path);

  expect(bytes.length).toBeGreaterThan(20_000);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  const raw = bytes.toString('latin1');
  // Document properties and an outline are what make this a document rather
  // than a printout; both are set by the renderer.
  expect(raw).toContain('/Title');
  expect(raw).toContain('/Outlines');
  expect(raw).toContain('/Author');

  expect(errors).toEqual([]);
});

test('every ranked plan has a finite cost, so nothing can print as NaN', async ({ page }) => {
  await boot(page);
  const bad = await page.evaluate(() => {
    const rec = window.getRecommendation();
    return rec.ranked
      .filter((r) => !Number.isFinite(r.net))
      .map((r) => `${r.plan.id} = ${r.net}`);
  });
  expect(bad).toEqual([]);
});

test('generates for a home with no solar and no EV', async ({ page }) => {
  const errors = await boot(page, {
    has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0, ev_active: false,
  });
  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  expect(errors).toEqual([]);
});

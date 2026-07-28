import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Getting the finished report onto the reader's device.
 *
 * jsPDF's doc.save() builds a blob URL and clicks an <a download>. On iOS
 * Safari the download attribute is ignored for blob URLs, and inside an
 * installed PWA there is no download UI at all — so nothing happens, nothing
 * throws, and the app said "Report downloaded" over a file that did not exist.
 * That is exactly how it was reported: the download not working, with no error
 * to go on.
 *
 * Real Safari cannot be driven from here, so these tests stub the two platform
 * facts that decide the route and assert the branch taken and the answer given.
 * That is weaker than testing a real iPhone and is stated plainly rather than
 * dressed up: what is pinned is the decision, not the platform behaviour.
 */

const HOME = {
  current_screen: 'result', has_solar: true, considering_solar: true,
  count_A: 10, battery_kwh: 9, panel_w: 440, install_cost: 12000, grant_seai: 1800,
};

/** Build a small PDF and deliver it under a stubbed platform. */
const deliver = (page, setup) => page.evaluate(async (src) => {
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const { jsPDF } = window.jspdf || window;
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  doc.text('report', 10, 10);
  try { return await window.deliverPdf(doc, 'report.pdf'); }
  catch (e) { return 'THREW: ' + e.message; }
}, setup);

test.beforeEach(async ({ page }) => {
  await boot(page, HOME);
  await page.evaluate(() => window.ensureJsPdf());
  await page.waitForFunction(() => !!(window.jspdf || window.jsPDF), null, { timeout: 20_000 });
});

test('on iOS the report goes to the share sheet, which is the only route to Files', async ({ page }) => {
  const how = await deliver(page, `
    window.__shared = null;
    Object.defineProperty(navigator, 'platform', { value: 'iPhone', configurable: true });
    navigator.canShare = (d) => !!(d && d.files);
    navigator.share = async (d) => { window.__shared = d.files[0]; };`);

  expect(how, 'iOS fell through to a download that cannot work there').toBe('shared');
  const file = await page.evaluate(() => window.__shared && {
    name: window.__shared.name, type: window.__shared.type, size: window.__shared.size });
  expect(file.name).toBe('report.pdf');
  expect(file.type).toBe('application/pdf');
  expect(file.size, 'an empty file was handed to the share sheet').toBeGreaterThan(500);
});

test('dismissing the share sheet is a decision, not a failure', async ({ page }) => {
  const how = await deliver(page, `
    Object.defineProperty(navigator, 'platform', { value: 'iPhone', configurable: true });
    navigator.canShare = (d) => !!(d && d.files);
    navigator.share = async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; };`);

  // Falling back to a download here would push a second copy at someone who
  // just said no, and on iOS that copy goes nowhere anyway.
  expect(how).toBe('cancelled');
});

test('platforms where downloads work still get a download', async ({ page }) => {
  // Android and some desktops can share a file too. A download is the better
  // outcome there: it lands in Downloads instead of asking which app gets it.
  const how = await deliver(page, `
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
    navigator.canShare = (d) => !!(d && d.files);
    navigator.share = async () => { window.__shared = 'should not happen'; };`);

  expect(how).toBe('downloaded');
  expect(await page.evaluate(() => window.__shared)).toBeUndefined();
});

test('the whole path still works from the button a person actually taps', async ({ page }) => {
  // The other PDF tests call doGeneratePdf() directly and never touch the UI,
  // so the modal and its buttons were never covered.
  await page.locator('.report-promo').click();
  await expect(page.locator('#pdf-modal')).toBeVisible();

  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.locator('#pdf-modal button', { hasText: /download/i }).first().click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^solar-optimiser-report-\d{4}-\d{2}-\d{2}\.pdf$/);
});

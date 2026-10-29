import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot } from './support.js';

/**
 * The report's picture of the home is Profile's (29 Oct 2026). The report used
 * to draw a house of its own, flat and nothing like the app's; it now has the
 * app paint its own drawing, styled by its own stylesheet, and sets the words
 * over it in the same typeface.
 */
const HOME = { ev_active: true, ev_km_per_year: 16500, heating_type: 'heatpump' };

/** Every shape on Profile's picture, and every one the report was painted from: what it is and how it is styled. */
const shapes = (page) => page.evaluate(async () => {
  const PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
    'stroke-linecap', 'stroke-linejoin', 'opacity', 'filter'];
  const GEOM = ['points', 'd', 'cx', 'cy', 'r'];
  const read = (svg, style) => [...svg.querySelectorAll('polygon, path, circle, rect')]
    .filter((n) => !n.closest('defs, #hs-card-back') && !n.classList.contains('hs-hit'))
    .map((n) => [n.tagName, ...GEOM.map((a) => n.getAttribute(a)), style(n)].join('|'));
  window.setScreen('profile');
  const onScreen = document.querySelector('.hs-svg');
  const screen = read(onScreen, (n) => { const cs = getComputedStyle(n); return PAINT.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';'); });
  const words = [...document.querySelectorAll('.hs-top span, .hs-label tspan')].map((n) => n.textContent.trim());
  const p = await window.__housePrint();
  const printed = new DOMParser().parseFromString(p.svg, 'image/svg+xml').documentElement;
  return { screen, print: read(printed, (n) => n.getAttribute('style')), words, printWords: p.words.map((w) => w.text.trim()),
    printText: printed.querySelectorAll('text').length, printTaps: printed.querySelectorAll('.hs-hit, title').length };
});

for (const [name, home, has] of [
  ['panels, battery, car and heat pump', HOME, ['Grid', 'Solar', 'Battery', 'Home', 'EV', 'installed']],
  ['panels planned, nothing else', { solar_planned: true, battery_kwh: 0 }, ['Grid', 'Solar', 'Home', 'planned']],
]) {
  test(`the report is painted from Profile's picture, ${name}: the same shapes, styled the same, with the same words`, async ({ page }) => {
    const errors = await boot(page, home);
    const r = await shapes(page);
    expect(r.screen.length).toBeGreaterThan(50);
    expect(r.print).toEqual(r.screen);
    // The words are set by the report as text, so none are left in the painting, nor are the tap targets.
    expect(r.printText).toBe(0);
    expect(r.printTaps).toBe(0);
    expect(r.printWords).toEqual(r.words);
    expect(r.words).toEqual(expect.arrayContaining(has));
    expect(errors).toEqual([]);
  });
}

test('the painting is the card at four dots to the pixel: the ink, the sun, and white past its corners', async ({ page }) => {
  await boot(page, HOME);
  const r = await page.evaluate(async () => {
    const p = await window.__housePrint();
    const img = new Image();
    img.src = p.image;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // In the card's units: its corner, its left edge, and the sun (188, 30 on the drawing, 14 in and 40 down on the card).
    const at = (x, y) => [...ctx.getImageData(Math.round(x * 4), Math.round(y * 4), 1, 1).data].slice(0, 3);
    return { type: p.image.slice(0, p.image.indexOf(',')), w: img.width, h: img.height, width: p.width, height: p.height,
      corner: at(0.5, 0.5), edge: at(4, 200), sun: at(14 + 188, 40 + 30) };
  });
  expect(r.type).toBe('data:image/jpeg;base64');
  expect(r.w).toBe(Math.round(r.width * 4));
  expect(r.h).toBe(Math.round(r.height * 4));
  const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  expect(near(r.corner, [255, 255, 255]), `corner ${r.corner}`).toBe(true);
  expect(near(r.edge, [0x16, 0x34, 0x3d]), `card ${r.edge}`).toBe(true);
  expect(near(r.sun, [0xff, 0xd1, 0x66]), `sun ${r.sun}`).toBe(true);
});

test('the report carries the painting', async ({ page }, testInfo) => {
  const errors = await boot(page, HOME);
  const width = await page.evaluate(async () => Math.round((await window.__housePrint()).width * 4));
  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  const path = testInfo.outputPath('report.pdf');
  await file.saveAs(path);
  const raw = readFileSync(path).toString('latin1');
  expect(raw).toContain(`/Width ${width}\n`);
  expect(raw).toContain('/DCTDecode');
  expect(errors).toEqual([]);
});

test('a picture that can\'t be painted leaves the rest of the report whole', async ({ page }, testInfo) => {
  const errors = await boot(page, HOME);
  await page.evaluate(() => { HTMLImageElement.prototype.decode = () => Promise.reject(new Error('no painting today')); });
  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  const file = await download;
  // The text version is the fallback when the PDF itself fails; this must still be the PDF.
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  const path = testInfo.outputPath('report.pdf');
  await file.saveAs(path);
  const raw = readFileSync(path).toString('latin1');
  expect(raw).not.toContain('/DCTDecode');
  expect(errors).toEqual([]);
});

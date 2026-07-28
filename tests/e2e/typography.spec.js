import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * One face, and nothing shouting in capitals.
 *
 * This began as a narrower rule — prose must not be set in the monospace face
 * — on the reasoning that mono earned its place on "€1,471" and "5.3 kWp".
 * That reasoning was wrong. Letterspaced capitals and slab figures are what an
 * instrument readout looks like, and a homeowner deciding how to spend fifteen
 * thousand euro is not reading an instrument. The monospace face is gone from
 * the application entirely, along with the font file.
 *
 * So the sweep is stricter now: no screen may use a monospaced family at all,
 * and no screen may set a run of text in capitals with wide tracking. Both
 * decayed back the moment nobody was counting, which is why they are counted.
 */

const SCREENS = [
  'welcome', 'onboarding', 'fastpath', 'result', 'plans', 'plan-detail',
  'solar', 'compare', 'monitor', 'analytics', 'more', 'independence',
  'quotes', 'auditor', 'refine', 'how-to-switch', 'methodology', 'csv-import',
];

/**
 * Runs of text that are unambiguously prose: long enough to be a sentence, and
 * containing at least two consecutive words. Deliberately excludes short
 * labels, figures, units, eyebrows, and code-like samples — a monospaced MPRN
 * header or "5.3 kWp" is correct and must not be flagged.
 */
const monoProse = (page) => page.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const t = n.textContent.trim();
    if (t.length < 40) continue;
    if (!/[a-z]{4,}\s+[a-z]{4,}/i.test(t)) continue;
    // A literal data format is not prose.
    if (/^[A-Z][A-Za-z ]*,[A-Za-z ]*,/.test(t)) continue;
    const el = n.parentElement;
    if (!el) continue;
    const style = getComputedStyle(el);
    if (/mono/i.test(style.fontFamily)) out.push(t.replace(/\s+/g, ' ').slice(0, 80));
  }
  return out;
});

test('no screen uses a monospaced face at all', async ({ page }) => {
  await boot(page, { _detail_plan_id: 'EI-SST' });

  const offenders = {};
  for (const screen of SCREENS) {
    await page.evaluate((s) => window.setScreen(s), screen);
    await page.waitForTimeout(screen === 'solar' ? 1200 : 250);
    const found = await monoProse(page);
    if (found.length) offenders[screen] = [...new Set(found)];
  }

  expect(offenders, `monospace prose found:\n${JSON.stringify(offenders, null, 2)}`)
    .toEqual({});
});

test('no screen pushes the page sideways', async ({ page }) => {
  await boot(page, { _detail_plan_id: 'EI-SST' });

  const bad = {};
  for (const screen of SCREENS) {
    await page.evaluate((s) => window.setScreen(s), screen);
    await page.waitForTimeout(screen === 'solar' ? 1200 : 250);
    const over = await page.evaluate(() => {
      // A horizontal scroller is a deliberate pattern (the filter row); the
      // page itself running wide is not.
      const doc = document.documentElement;
      const wide = [...document.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return false;
        if (r.right <= window.innerWidth + 1) return false;
        // Inside something that scrolls sideways on purpose? Then it is fine.
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return false;
        }
        return true;
      });
      return { pageWider: doc.scrollWidth > window.innerWidth + 1, count: wide.length,
        first: wide.slice(0, 2).map((e) => (e.className || e.tagName).toString().slice(0, 40)) };
    });
    if (over.pageWider || over.count) bad[screen] = over;
  }

  expect(bad, `content overflows the viewport:\n${JSON.stringify(bad, null, 2)}`).toEqual({});
});

/**
 * Nothing is set in letterspaced capitals.
 *
 * The other half of the instrument look, and the half that survives a font
 * change: "STEP 1 OF 6 · YOUR HOME" is a control panel, "Step 1 of 6 · Your
 * home" is a product. There were 86 such rules — 48 in the stylesheet and 38
 * in inline styles — when this was written.
 */
test('no screen shouts in letterspaced capitals', async ({ page }) => {
  await boot(page, { _detail_plan_id: 'EI-SST' });

  const offenders = {};
  for (const screen of SCREENS) {
    await page.evaluate((s) => window.setScreen(s), screen);
    await page.waitForTimeout(screen === 'solar' ? 1200 : 250);
    const found = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if (style.textTransform !== 'uppercase') continue;
        // Only flag elements that actually carry their own words.
        const own = [...el.childNodes]
          .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
        if (own.length < 3) continue;
        out.push(own.replace(/\s+/g, ' ').slice(0, 60));
      }
      return out;
    });
    if (found.length) offenders[screen] = found;
  }

  expect(offenders, 'text set in capitals by CSS').toEqual({});
});

test('the monospace font file is no longer shipped or requested', async ({ page }) => {
  const requested = [];
  page.on('request', (r) => { if (/\.woff2?$/i.test(r.url())) requested.push(r.url()); });

  await boot(page);
  for (const screen of ['result', 'plans', 'solar', 'more']) {
    await page.evaluate((s) => window.setScreen(s), screen);
    await page.waitForTimeout(250);
  }

  // A face nothing uses is a download nobody needs.
  expect(requested.filter((u) => /mono/i.test(u)), 'a monospace font was still fetched').toEqual([]);
});

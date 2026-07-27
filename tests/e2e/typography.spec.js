import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Prose is set in the prose face, on every screen.
 *
 * JetBrains Mono earns its place on €1,471 and 5.3 kWp. Set on sentences it
 * renders the whole surface as terminal output and signals *machine* rather
 * than *advisor* — which is most of why the app read as an enhanced calculator
 * rather than something that tells you what to do. There were twenty-four such
 * runs across eighteen screens when this was written.
 *
 * This is a sweep rather than a per-screen assertion because the rule is only
 * worth anything if it holds everywhere, and because the offenders were spread
 * across fourteen CSS classes and six inline styles — exactly the kind of thing
 * that decays back if nobody is counting.
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
    // Eyebrows and section labels are a deliberate typographic signature:
    // uppercase, widely tracked, and never carrying a sentence's worth of
    // meaning on their own.
    if (style.textTransform === 'uppercase') continue;
    if (/mono/i.test(style.fontFamily)) out.push(t.replace(/\s+/g, ' ').slice(0, 80));
  }
  return out;
});

test('no screen sets prose in the monospace face', async ({ page }) => {
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

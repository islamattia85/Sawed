import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The home screen is an answer, not a readout.
 *
 * It used to open with an amber warning about data freshness — an apology above
 * the answer — then state the saving and hedge it four times before the button:
 * usage assumptions, "estimated from your bill", an import nudge, and three
 * config chips. Below that sat ten cards of near-identical weight, so the reader
 * had to construct the hierarchy themselves. That is what a calculator does. It
 * shows every register at once and leaves the judgement to you.
 *
 * These tests hold the three properties that make it a product instead: the
 * answer and its action arrive first, there is exactly one primary action, and
 * prose is set in the prose face. None of them assert that anything was
 * deleted — the working is checked separately, and must still contain
 * everything it used to.
 */

test('the answer and its action arrive before anything else', async ({ page }) => {
  const errors = await boot(page);

  const geo = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    return {
      value: box('.hero-inset-value')?.top ?? null,
      ctaBottom: box('.hero-cta')?.bottom ?? null,
      viewport: window.innerHeight,
      height: document.body.scrollHeight,
    };
  });

  expect(geo.value, 'no headline figure').not.toBeNull();
  expect(geo.ctaBottom, 'the action is not fully visible without scrolling')
    .toBeLessThan(geo.viewport);
  expect(geo.height / geo.viewport, `the home screen is ${(geo.height / geo.viewport).toFixed(1)} screens long`)
    .toBeLessThan(2);

  expect(errors).toEqual([]);
});

test('there is one primary action, not a menu of them', async ({ page }) => {
  await boot(page);
  // The hero panel may carry a second action — "Switch to X" beneath "See the
  // full recommendation" — but only one of them may read as primary. That is
  // what `.ghost` is for: a clear second place rather than a choice between
  // two equals. Links ("Pick a different plan") are not in this contest at all.
  const primaries = await page.locator('.hero-cta:not(.ghost)').count();
  expect(primaries, 'more than one primary call to action').toBe(1);

  // And whatever else is on the panel must be visibly subordinate.
  const weights = await page.evaluate(() => [...document.querySelectorAll('.hero-cta')]
    .map((el) => ({ ghost: el.classList.contains('ghost'), bg: getComputedStyle(el).backgroundColor })));
  const solid = weights.filter((w) => !w.ghost);
  expect(solid.length).toBe(1);
});

test('prose is set in the prose face', async ({ page }) => {
  await boot(page);

  const mono = await page.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const t = n.textContent.trim();
      // A sentence, not a figure or a label.
      if (t.length < 40 || !/[a-z]{4,}\s+[a-z]{4,}/i.test(t)) continue;
      if (/mono/i.test(getComputedStyle(n.parentElement).fontFamily)) out.push(t.slice(0, 60));
    }
    return out;
  });

  // Monospace on a sentence reads as terminal output, and turns the whole
  // surface into machine exhaust. Figures keep it; prose does not.
  expect(mono, `monospace prose on the home screen: ${mono.join(' | ')}`).toEqual([]);
});

test('nothing was deleted — the working still holds all of it', async ({ page }) => {
  const errors = await boot(page);

  // Collapsed by default.
  await expect(page.locator('.plan-compare')).toHaveCount(0);
  await page.locator('.working-toggle').click();

  const text = await page.evaluate(() => document.querySelector('.working-body').innerText);
  for (const [what, re] of [
    ['the plan comparison', /Your current plan|Estimated baseline/i],
    ['the savings breakdown', /Total saving/i],
    ['the assumptions', /What this is based on/i],
    ['the working', /How we calculated this/i],
    ['the health score', /Energy health score/i],
  ]) {
    expect(text, `${what} is gone, not moved`).toMatch(re);
  }

  expect(errors).toEqual([]);
});

test('freshness is disclosed on the answer, not buried in the working', async ({ page }) => {
  await boot(page);
  const chip = page.locator('.fresh-chip');
  await expect(chip).toBeVisible();

  // Tapping it still leads to the per-plan dates — the honesty is intact, it is
  // just no longer standing in front of the answer.
  await chip.click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('plans');
});

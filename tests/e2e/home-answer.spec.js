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
      value: box('.qr-value')?.top ?? null,
      ctaBottom: box('.switch-cta')?.bottom ?? null,
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
  // Buttons that read as primary. "Pick a different plan" and "How switching
  // works" are links precisely so the reader is not asked to choose between
  // choosing and acting.
  const primaries = await page.locator('.switch-cta').count();
  expect(primaries, 'more than one primary call to action').toBe(1);
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

/**
 * The rule is that nothing is deleted. It was written when the working panel
 * was the only place anything could go, so it asserted that everything was in
 * that one panel — which is why the panel grew to seven cards and became the
 * thing readers complained about.
 *
 * V6 keeps the rule and drops the assumption. Whatever answers "how did you
 * work that out?" stays on the answer. What asks "what could I do instead?" —
 * the health score, the night-rate prompt, the EV-versus-petrol sum — moved to
 * Simulate, which is the surface for exactly that question. So this test now
 * checks both places: still present, and reachable.
 */
test('nothing was deleted — the working and Simulate hold all of it', async ({ page }) => {
  const errors = await boot(page);

  // Collapsed by default.
  await expect(page.locator('.plan-compare')).toHaveCount(0);
  await page.locator('.working-toggle').click();

  const working = await page.evaluate(() => document.querySelector('.working-body').innerText);
  for (const [what, re] of [
    ['the plan comparison', /Your current plan|Estimated baseline/i],
    ['the savings breakdown', /Total saving/i],
    ['the assumptions', /What this is based on/i],
    ['the working', /How we calculated this/i],
  ]) {
    expect(working, `${what} is gone from the answer, not moved`).toMatch(re);
  }

  // …and what left the answer landed on Simulate rather than vanishing.
  await page.evaluate(() => window.setScreen('solar'));
  const simulate = await page.evaluate(() => document.body.innerText);
  expect(simulate, 'the health score is gone, not moved').toMatch(/Energy health score/i);

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

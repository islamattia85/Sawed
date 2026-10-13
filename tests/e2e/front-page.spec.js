import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

/**
 * Direction section 4 (13 Oct 2026): the front page shows the product and
 * stops arguing for it. On a phone it is at most eight screens, in this order:
 * the hero and its three doors (solar first), the four-bill card, how it works,
 * why the plan matters (three lines), five questions, five answers, the footer.
 */

async function open(page, width, height) {
  await isolate(page);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
}

/** The page's parts, top to bottom, by id or first class. */
const parts = (page) => page.evaluate(() => [...document.querySelectorAll('.wl-site > header, .wl-site > section, .wl-site > footer, .wl-hero > figure')]
  .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
  .map((e) => e.id || e.className.split(' ')[0]));

test('on a phone the front page is at most eight screens, in the order the brief sets', async ({ page }) => {
  await open(page, 390, 844);
  const { H, vh, sw } = await page.evaluate(() => ({ H: document.documentElement.scrollHeight, vh: innerHeight, sw: document.documentElement.scrollWidth - innerWidth }));
  expect(H / vh, `${H}px tall`).toBeLessThanOrEqual(8);
  expect(sw).toBeLessThanOrEqual(1);
  expect(await parts(page)).toEqual(['wl-bar', 'wl-hero', 'wl-shot', 'how', 'plan', 'ask', 'faq', 'wl-foot']);
});

test('the hero leads with solar and says nobody pays to be ranked', async ({ page }) => {
  await open(page, 390, 844);
  await expect(page.locator('.wl-journey b')).toHaveText(['I’m thinking about solar', 'I have solar', 'Just a better plan']);
  await expect(page.locator('.wl-lede')).toContainText(/Free\. No supplier pays to be ranked\.$/);
  await expect(page.locator('.wl-hero .wl-pb-h')).toContainText('One home, four bills a year');
  await expect(page.locator('#how > div')).toHaveCount(3);
});

test('what stays is cut to size: three lines, five questions, five answers', async ({ page }) => {
  await open(page, 390, 844);
  await expect(page.locator('#plan .wl-points > div')).toHaveCount(3);
  await expect(page.locator('#plan figure, #plan .wl-pb')).toHaveCount(0);
  await expect(page.locator('.wl-ask-q b')).toHaveText(['They told me five years. Is that right?', 'Is it the right system for my roof?',
    'Is my quote fair?', 'What if export pay drops, or night rates go up?', 'I just want a cheaper plan.']);
  await expect(page.locator('#faq summary')).toHaveText(['Does solar really pay back in five years?', 'Do I need to switch plan once the panels are in?',
    'Do I need a smart meter?', 'Is switching safe? Will my power go off?', 'How does Peakless make money?']);
  const text = await page.locator('.wl-site').innerText();
  expect(text).not.toMatch(/Years to earn back|What you get|Try it on a typical|Built to be checked|The plans we compare|Plan types|sample report|Find out what your panels/i);
  // No link to a section that is gone (the legal links open app screens instead).
  expect(await page.locator('.wl-site a[href^="#"]:not([onclick])').evaluateAll((as) => as.map((a) => a.getAttribute('href')).filter((h) => !document.querySelector(h))))
    .toEqual([]);
});

test('desktop keeps the same content beside the two-column hero', async ({ page }) => {
  await open(page, 1280, 900);
  expect(await parts(page)).toEqual(['wl-bar', 'wl-hero', 'wl-shot', 'how', 'plan', 'ask', 'faq', 'wl-foot']);
  const copy = await page.locator('.wl-hero .wl-copy').boundingBox();
  const card = await page.locator('.wl-hero .wl-shot').boundingBox();
  expect(card.x, 'the four-bill card sits beside the words').toBeGreaterThan(copy.x + copy.width - 1);
});

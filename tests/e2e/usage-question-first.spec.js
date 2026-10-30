import { test, expect } from '@playwright/test';
import { isolate } from './support.js';

/**
 * The usage question from the first screen (30 Oct 2026). It was asked only in
 * the app's bottom bar, which the front page and setup don't have, so a first
 * visit set up, added its meter file and finished before it was asked, and none
 * of setup was ever counted: 0 "setup finished" in the first day's counts.
 */
async function firstVisit(page, path) {
  await isolate(page);
  await page.route('**/api/consent', (r) => r.fulfill({ status: 200, json: { ok: true } }));
  await page.goto(path);
  await page.waitForFunction(() => window.__bootSettled === true);
}

/** The two boxes overlap. */
const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const path of ['/', '/app']) {
  test(`a first visit to ${path} is asked on the first screen and through setup, and the question covers nothing`, async ({ page }) => {
    await firstVisit(page, path);
    const bar = page.locator('.consent-bar');
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Allow' })).toBeInViewport();
    // At the end of the page it takes its own room: nothing is left under it.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const under = await page.evaluate(() => {
      const b = document.querySelector('.consent-bar').getBoundingClientRect();
      return [...document.querySelectorAll('#app-root a, #app-root button')].filter((e) => !e.closest('.consent-bar'))
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height && r.bottom > b.top && r.top < b.bottom && r.right > b.left && r.left < b.right).length;
    });
    expect(under).toBe(0);

    // In setup on a phone it sits below the question: Next stays clear of it on a short screen.
    await page.evaluate(() => window.startFlow('full'));
    await expect(bar).toBeVisible();
    const next = page.locator('.fl-q button', { hasText: /^Next$/ }).first();
    await expect(next).toBeInViewport();
    expect(overlap(await next.boundingBox(), await bar.boundingBox())).toBe(false);
  });
}

test('Privacy, opened from the question in setup, comes back to the same question', async ({ page }) => {
  await firstVisit(page, '/');
  await page.evaluate(() => window.startFlow('full'));
  await page.locator('.fl-q button', { hasText: /^Next$/ }).first().click();
  const question = await page.locator('.fl-q').innerText();
  await page.locator('.consent-bar a', { hasText: 'Privacy' }).click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('privacy');
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('flow');
  expect(await page.locator('.fl-q').innerText()).toBe(question);
});

test('once answered, on the front page, it is gone from the front page, setup and Home', async ({ page }) => {
  await firstVisit(page, '/');
  await page.locator('.consent-bar').getByRole('button', { name: 'No thanks' }).click();
  await expect(page.locator('.consent-bar')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sawed_analytics'))).toBe('no');
  await page.evaluate(() => window.startFlow('full'));
  await expect(page.locator('.consent-bar')).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true);
  await expect(page.locator('.consent-bar')).toHaveCount(0);
});

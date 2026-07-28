import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The account surface has failed silently twice, in two different ways, and
 * neither was caught because the happy path never opens it.
 *
 * First, all seven handlers were missing from `window` after the ES-module
 * migration, so every click was an uncaught ReferenceError. Then, once they
 * worked, the sheet they belong to still never rendered: signed out,
 * renderAuthModal() returned an empty string, so the header control navigated
 * to a hard-coded black intro screen instead — and its "Continue with Email"
 * set a flag and moved to the welcome screen, which returns from renderApp()
 * before any modal is injected. renderAuthSection(), a complete themed sign-in
 * panel, sat in the source with no call site anywhere in the app.
 *
 * These tests drive the controls a user actually presses.
 */

/** The bundled client is present but the API host is unreachable here. */
const blockApi = (page) => page.route('**/*', (route) => (
  /supabase\.co|jsdelivr/.test(route.request().url()) ? route.abort() : route.continue()));

test('the header control opens a sign-in sheet, in the app’s own theme', async ({ page }) => {
  const errors = await boot(page);
  await blockApi(page);

  await page.locator('.profile-nav-btn').first().click();
  await expect(page.locator('#auth-modal-root')).toHaveCount(1);

  // Not a full-screen takeover, and not the black intro screen: the app is
  // still behind it and the page is still in the light theme.
  expect(await page.evaluate(() => window.state.current_screen)).toBe('result');
  const chrome = await page.evaluate(() => document.getElementById('app-root')?.getAttribute('data-chrome'));
  expect(chrome, 'the sign-in screen replaced the app instead of overlaying it').toBe('app');

  expect(errors).toEqual([]);
});

test('the email form renders and accepts input', async ({ page }) => {
  const errors = await boot(page);
  await blockApi(page);

  await page.locator('.profile-nav-btn').first().click();
  await page.getByRole('button', { name: /Continue with email/i }).first().click();

  await expect(page.locator('#auth-email')).toBeVisible();
  await expect(page.locator('#auth-password')).toBeVisible();
  await expect(page.locator('#auth-submit-btn')).toBeVisible();

  await page.fill('#auth-email', 'someone@example.com');
  await page.fill('#auth-password', 'hunter2hunter2');
  expect(await page.inputValue('#auth-email')).toBe('someone@example.com');

  expect(errors).toEqual([]);
});

test('submitting reaches the client and reports failure in plain language', async ({ page }) => {
  const errors = await boot(page);
  await blockApi(page);

  await page.locator('.profile-nav-btn').first().click();
  await page.getByRole('button', { name: /Continue with email/i }).first().click();
  await page.fill('#auth-email', 'someone@example.com');
  await page.fill('#auth-password', 'hunter2hunter2');
  await page.locator('#auth-submit-btn').click();

  // The client is bundled, so it initialises even with the CDN blocked, gets as
  // far as the network, and surfaces a message the reader can act on rather
  // than a raw "Failed to fetch" — or, as before, nothing at all.
  const msg = page.locator('#auth-msg');
  await expect(msg).not.toBeEmpty({ timeout: 15_000 });
  await expect(msg).toContainText(/connection|reach|match an account|try again/i);

  // This used to assert the raw error never appeared at all. That position has
  // changed deliberately: "log in not working" could not be narrowed from the
  // friendly sentence alone — a paused project, a wrong key, a rejected
  // password and a blocked network all read the same. The reason is now kept
  // as a small second line. What must not happen is the raw error appearing
  // INSTEAD of plain language, so the plain sentence has to come first.
  const text = (await msg.innerText()).trim();
  expect(text.split('\n')[0], 'the message leads with a raw error')
    .toMatch(/connection|reach|match an account|try again/i);
  expect(text.split('\n')[0]).not.toMatch(/failed to fetch/i);

  expect(errors).toEqual([]);
});

test('sign-up and password reset views are reachable', async ({ page }) => {
  const errors = await boot(page);
  await blockApi(page);

  await page.locator('.profile-nav-btn').first().click();
  await page.getByRole('button', { name: /Continue with email/i }).first().click();

  await page.locator('#auth-modal-root').getByText('Create free account').click();
  await expect(page.locator('#auth-name')).toBeVisible();
  expect(await page.evaluate(() => window._authEmailView)).toBe('signup');

  await page.locator('#auth-modal-root').locator('a', { hasText: /^Sign in$/ }).click();
  await expect(page.locator('.auth-forgot')).toBeVisible();
  await page.locator('.auth-forgot').click();
  expect(await page.evaluate(() => window._authEmailView)).toBe('forgot');

  expect(errors).toEqual([]);
});

test('no screen in the app renders on a hard-coded black background', async ({ page }) => {
  const errors = await boot(page, { theme: 'light' });
  await blockApi(page);

  // The intro screen paints #0a0a0a regardless of theme. It must not be
  // reachable from the signed-out account control in a light-themed app.
  await page.locator('.profile-nav-btn').first().click();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  const luminance = (r + g + b) / 3;
  expect(luminance, `body painted ${bg} while the app is in light theme`).toBeGreaterThan(120);

  expect(errors).toEqual([]);
});

/**
 * A form that cannot work must still answer you.
 *
 * sbInitialized() only checked that the Supabase URL and key constants exist,
 * so the sign-in sheet rendered whenever the app had keys — including when
 * createClient() had never run because the dynamic import failed. Submitting
 * then read .auth off null inside an un-awaited try-less call: the button
 * disabled itself, no message appeared, and nothing happened. That is what
 * "log in not working" looks like from the outside, with nothing to report.
 */
test('a broken client still produces a message, and re-enables the button', async ({ page }) => {
  const errors = await boot(page);
  await blockApi(page);

  // Simulate the client never having been built, and make rebuilding fail too.
  await page.evaluate(() => {
    window._sb = null;
    window.__sbInitBlocked = true;
  });

  await page.locator('.profile-nav-btn').first().click();
  await page.getByRole('button', { name: /Continue with email/i }).first().click();
  await page.fill('#auth-email', 'someone@example.com');
  await page.fill('#auth-password', 'hunter2hunter2');
  await page.locator('#auth-submit-btn').click();

  const msg = page.locator('#auth-msg');
  await expect(msg, 'submitting said nothing at all').not.toBeEmpty({ timeout: 20_000 });
  await expect(msg).toContainText(/connection|reach|try again/i);

  // And the reader can try again rather than being left with a dead button.
  await expect(page.locator('#auth-submit-btn')).toBeEnabled();

  expect(errors, 'the failure escaped as an uncaught error').toEqual([]);
});


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

/**
 * Coming back from Google refused must not look like nothing happened.
 *
 * "Continue with Google" hands the browser to Supabase, which hands it to
 * Google, which sends it back here. When any step declines it returns with the
 * reason in the URL — in the query string, or in the hash for the implicit
 * flow. Nothing read either one. The app booted normally, showed the reader
 * signed out and said nothing: tap, watch a bounce, end up where you started
 * with no explanation.
 *
 * The hash case had a second problem. Screens are routed through the location
 * hash, so the first renderApp() replaced it with '#result' — the error was
 * destroyed before anything could read it. It is captured before first paint
 * now.
 */
const OAUTH_FAILURES = [
  ['the provider is not switched on', '/?error=server_error&error_description=Unsupported+provider%3A+provider+is+not+enabled', /not switched on/i, /provider is not enabled/i],
  ['this address is not allow-listed', '/?error=invalid_request&error_description=requested+path+is+invalid', /allow-list/i, /requested path is invalid/i],
  ['the reader cancelled', '/?error=access_denied&error_description=User+denied+access', /cancelled/i, /access_denied/i],
  ['the implicit flow returns it in the hash', '/#error=server_error&error_description=Unsupported+provider', /not switched on/i, /Unsupported provider/i],
];

for (const [label, url, friendly, detail] of OAUTH_FAILURES) {
  test(`a refused Google sign-in says so: ${label}`, async ({ page }) => {
    await boot(page);            // seeds storage and blocks the network
    await blockApi(page);
    // Land somewhere with a different query first. Going straight from "/" to
    // "/#error=..." is a same-document change: the app never re-boots, so
    // nothing would read the hash and the test would pass on a technicality.
    await page.goto('/?nav=1');
    await page.goto(url);
    await page.waitForFunction(() => window.__bootSettled === true);

    // The plain reason, where it can be read…
    const msg = page.locator('#auth-msg');
    await expect(msg, 'the app said nothing about the refusal').not.toBeEmpty({ timeout: 10_000 });
    await expect(msg).toContainText(friendly);
    // …and the exact one, which is the part that identifies the cause.
    await expect(msg).toContainText(detail);

    // The reason must not be left in the address bar to replay on refresh.
    const href = await page.evaluate(() => location.search + location.hash);
    expect(href, 'the error is still in the URL').not.toMatch(/error/);
  });
}

/**
 * The Google button must be able to say what went wrong.
 *
 * showAuthMsg() writes into #auth-msg and returns silently when it is not
 * there — and the provider chooser, the view the Google button actually lives
 * on, had no such element. Every Google failure was therefore reported into
 * nothing: the button flicked from "Connecting…" back to normal and said
 * nothing at all. From the outside that is a button that does not work.
 */
test('a failing Google sign-in reports it on the view the button is on', async ({ page }) => {
  const errors = await boot(page);
  await blockApi(page);

  // The client cannot be built, so the attempt fails immediately and locally —
  // the same shape as the provider being unavailable.
  await page.evaluate(() => { window._sb = null; window.__sbInitBlocked = true; });

  await page.locator('.profile-nav-btn').first().click();
  // The chooser is the default view: no tapping through to the email form.
  await expect(page.locator('.auth-google-btn')).toBeVisible();
  await expect(page.locator('#auth-msg'), 'the chooser has nowhere to print a message')
    .toHaveCount(1);

  await page.locator('.auth-google-btn').click();

  const msg = page.locator('#auth-msg');
  await expect(msg, 'tapping Google said nothing at all').not.toBeEmpty({ timeout: 15_000 });
  await expect(msg).toContainText(/connection|reach|try again/i);
  // And the button comes back, so it can be tried again.
  await expect(page.locator('.auth-google-btn')).toBeEnabled();
  await expect(page.locator('.auth-google-btn')).toContainText(/Continue with Google/i);

  expect(errors).toEqual([]);
});

/**
 * Coming back from Google with nothing at all.
 *
 * signInWithOAuth() assigns window.location itself by default, so the page is
 * unloaded the instant the button is tapped — anything the app then wants to
 * say is said to a document that no longer exists. And when the far end errors
 * without redirecting back, the reader ends up somewhere else with no session,
 * no error in the URL, and no way to know what happened. Tap, bounce, nothing.
 *
 * A sign-in that was started on this device and came back empty is now
 * reported. The URL is fetched rather than followed blindly, and the departure
 * is recorded so the return can be recognised.
 */
test('a Google round-trip that returns nothing is still reported', async ({ page }) => {
  await boot(page);
  await blockApi(page);

  // Exactly the state after tapping Google and being sent back empty-handed.
  await page.evaluate(() => sessionStorage.setItem('oauth_pending', String(Date.now())));
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true);

  const msg = page.locator('#auth-msg');
  await expect(msg, 'the empty round-trip was not reported').not.toBeEmpty({ timeout: 10_000 });
  await expect(msg).toContainText(/without signing you in/i);
  await expect(msg).toContainText(/provider is not enabled|allow-list/i);
});

test('an ordinary visit says nothing about sign-in', async ({ page }) => {
  await boot(page);
  await blockApi(page);
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true);
  await page.waitForTimeout(600);

  // The report must depend on a sign-in actually having been started here, or
  // it would accuse every normal visit of a failure.
  await expect(page.locator('.auth-modal-backdrop')).toHaveCount(0);
});

test('a stale departure is not reported days later', async ({ page }) => {
  await boot(page);
  await blockApi(page);
  await page.evaluate(() => sessionStorage.setItem('oauth_pending', String(Date.now() - 60 * 60 * 1000)));
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true);
  await page.waitForTimeout(600);

  await expect(page.locator('.auth-modal-backdrop')).toHaveCount(0);
});


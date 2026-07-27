import { test, expect } from '@playwright/test';
import { boot, bootFresh, collectErrors, isolate } from './support.js';

/**
 * These tests exist because of a specific hazard introduced by the move to ES
 * modules: inline `on*` attributes evaluate in GLOBAL scope, but module
 * top-level bindings are module-scoped. Any handler that reads or assigns a
 * module-level variable (`state.x = 1`, `_introStep = 3`) silently breaks
 * unless that binding is bridged onto window.
 *
 * Calling functions via page.evaluate() does NOT catch this — the bug only
 * shows when a real click evaluates the attribute. So every assertion here
 * drives the UI by clicking.
 */

test('window bridge exposes live module state, not a stale copy', async ({ page }) => {
  await boot(page);
  // Reassigning the module binding must be visible through window.
  const live = await page.evaluate(() => {
    const before = window.state.current_screen;
    window.setScreen('plans');
    return { before, after: window.state.current_screen };
  });
  expect(live.before).toBe('result');
  expect(live.after).toBe('plans');
});

test('inline handler assigning a nested state field works (Day Inspector season)', async ({ page }) => {
  // The day inspector now sits behind the solar screen's detail gate, so the
  // reader who has not asked for the working never sees it.
  const errors = await boot(page, { current_screen: 'solar', _di_season: 'summer', _solar_detail_open: true });
  const winter = page.getByRole('button', { name: /Winter/ });
  await winter.scrollIntoViewIfNeeded();
  await winter.click();
  // onclick="state._di_season='winter';renderApp()" — assignment through the bridge
  await expect.poll(() => page.evaluate(() => window.state._di_season)).toBe('winter');
  await expect(page.getByText(/Winter · Jan/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('inline handler toggling a boolean state field works (Home disclosure)', async ({ page }) => {
  const errors = await boot(page);
  const toggle = page.getByText('More about your result');
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await expect.poll(() => page.evaluate(() => !!window.state._home_detail_open)).toBe(true);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => !!window.state._home_detail_open)).toBe(false);
  expect(errors).toEqual([]);
});

test('inline handlers assigning module-scoped PRIMITIVES work', async ({ page }) => {
  // _authModalOpen and _authEmailView are bare `let` bindings in module scope.
  // Without the accessor bridge an inline `_authModalOpen=true` writes a dead
  // global and nothing on screen changes.
  const errors = await boot(page);
  await page.route('**/*', (r) => (/supabase\.co|jsdelivr/.test(r.request().url()) ? r.abort() : r.continue()));

  await page.locator('.profile-nav-btn').first().click();
  await expect.poll(() => page.evaluate(() => window._authModalOpen)).toBe(true);
  await expect(page.locator('#auth-modal-root')).toHaveCount(1);

  await page.getByRole('button', { name: /Continue with email/i }).first().click();
  await expect.poll(() => page.evaluate(() => window._authEmailView)).toBe('login');

  // …and the view toggles write through the same bridge.
  await page.locator('#auth-modal-root').getByText('Create free account').click();
  await expect.poll(() => page.evaluate(() => window._authEmailView)).toBe('signup');

  expect(errors).toEqual([]);
});

test('the first run opens on the welcome screen, not a carousel or a sign-in wall', async ({ page }) => {
  // Four screens used to precede the first input: a pitch, a feature list, a
  // sign-in wall, then the welcome screen repeating the pitch and the features.
  const errors = await bootFresh(page);
  expect(await page.evaluate(() => window.state.current_screen)).toBe('welcome');
  await expect(page.getByRole('button', { name: /Get my quick answer/ })).toBeVisible();

  // Two taps to an answer.
  await page.getByRole('button', { name: /Get my quick answer/ }).click();
  await page.getByRole('button', { name: /See my savings/ }).click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('result');
  expect(errors).toEqual([]);
});

test('onboarding drives _ob through clicks and commits', async ({ page }) => {
  const errors = await bootFresh(page);

  await page.evaluate(() => { window.state.seen_intro = true; window.setScreen('welcome'); });
  await page.getByRole('button', { name: /Full setup/ }).click();

  for (let step = 1; step <= 5; step += 1) {
    await expect.poll(() => page.evaluate(() => window._ob.step)).toBe(step);
    await expect(page.locator('.ob-step-num')).toContainText(`Step ${step} of 5`);
    if (step < 5) await page.getByRole('button', { name: /Continue/ }).click();
  }
  await page.getByRole('button', { name: /Show me my best plan/ }).click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('result');
  expect(errors).toEqual([]);
});

test('every screen renders without a page error', async ({ page }) => {
  const errors = await boot(page);
  const screens = ['result', 'plans', 'solar', 'compare', 'monitor', 'more', 'analytics',
    'quotes', 'auditor', 'refine', 'independence', 'methodology', 'how-to-switch', 'csv-import'];
  for (const s of screens) {
    await page.evaluate((x) => window.setScreen(x), s);
    await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe(s);
    // Unevaluated template literals leaking into the DOM is a real regression
    // we have shipped before — assert the rendered text never contains them.
    const raw = await page.evaluate(() => (document.body.innerText.match(/\$\{/g) || []).length);
    expect(raw, `raw template literals visible on "${s}"`).toBe(0);
  }
  expect(errors).toEqual([]);
});

test('back button walks the in-app stack', async ({ page }) => {
  await boot(page);
  for (const s of ['plans', 'more', 'methodology']) {
    await page.evaluate((x) => window.setScreen(x), s);
  }
  for (const expected of ['more', 'plans', 'result']) {
    await page.goBack();
    await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe(expected);
  }
});

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
  const errors = await boot(page, { current_screen: 'solar', _di_season: 'summer' });
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

test('inline handler assigning a module-scoped PRIMITIVE works (intro step)', async ({ page }) => {
  // _introStep is a bare `let` number. Without an accessor bridge, an inline
  // `_introStep=3` writes a dead global and the intro never advances.
  const errors = await bootFresh(page);

  await expect.poll(() => page.evaluate(() => window._introStep)).toBe(1);
  await page.locator('.intro-cta').first().click();
  await expect.poll(() => page.evaluate(() => window._introStep)).toBe(2);
  await page.locator('.intro-cta').first().click();
  await expect.poll(() => page.evaluate(() => window._introStep)).toBe(3);
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

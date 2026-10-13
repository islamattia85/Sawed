// @ts-check
/**
 * The legal pages and what the law asks the app to show (11 Oct 2026), from
 * the legal pack for Peakless Energy Limited:
 *
 * - the website shows the company's name and legal form, where it is
 *   registered and its number, and its registered office (Companies Act 2014,
 *   s.151(4)); details not yet supplied show as "to be added", never as nothing;
 * - every legal page opens from a plain link for a first-time visitor, and
 *   each lists the others;
 * - How we rank plans gives the sum and says nobody pays to move a plan up;
 * - the usage-counts question gives "No thanks" the same weight as "Allow";
 * - making an account says it is for people 18 and over.
 */
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const PAGES = [['privacy', 'Who we are'], ['terms', 'Our responsibility to you'], ['ranking', 'How the cost is worked out'],
  ['accessibility', 'How far we’ve got'], ['complaints', 'If you’re not happy with our answer']];

test('the website names the company as the law asks, in its footer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await boot(page, { onboarding_complete: false, current_screen: 'welcome' }, '/');
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  const line = page.locator('footer.wl-foot .wl-company').first();
  await expect(line).toContainText('Peakless Energy Limited, a private company limited by shares.');
  await expect(line).toContainText('Registered in Ireland, number');
  await expect(line).toContainText('Registered office:');
  // Not formed yet: the number and office say so rather than leaving a gap.
  await expect(line).toContainText('[company number to be added]');
  for (const name of ['Privacy', 'Terms', 'How we rank', 'Accessibility', 'Complaints'])
    await expect(page.locator('footer.wl-foot').first().getByRole('link', { name })).toBeVisible();
  expect(errors).toEqual([]);
});

test('each legal page opens from a link before setup, names the company, and lists the others', async ({ page }) => {
  await boot(page);
  for (const [screen, heading] of PAGES) {
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/app#${screen}`);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loader'));
    const copy = page.locator('.privacy-copy');
    await expect(copy.locator('h3', { hasText: heading }), screen).toBeVisible();
    await expect(copy.locator('.privacy-date'), screen).toContainText('Peakless Energy Limited');
    await expect(page.locator('.legal-links a'), screen).toHaveCount(PAGES.length - 1);
  }
});

test('How we rank plans: one sum, nobody pays to move up, and it counts the plans a new customer can join', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'ranking' });
  const copy = page.locator('.privacy-copy');
  await expect(copy).toContainText('Nobody pays us to show a plan, or to move it up.');
  // The plans a new customer can join: the same count the front page and How it works give (withdrawn ones are not compared).
  const n = await page.evaluate(() => window.TARIFFS ? window.TARIFFS.filter((t) => !t.discontinued && !t.assumed_only && !t.on_hold).length : null);
  const text = await copy.innerText();
  const m = text.match(/(\d+) plans from (\d+) suppliers/);
  expect(m, text).not.toBeNull();
  if (n) expect(Number(m[1])).toBe(n);
  expect(errors).toEqual([]);
});

test('the usage-counts question: No thanks weighs the same as Allow, and the answer is logged with the wording shown', async ({ page }) => {
  await boot(page, { askConsent: true });
  let logged = null;
  await page.route('**/api/consent', async (route) => { logged = route.request().postDataJSON(); await route.fulfill({ status: 200, body: '{}' }); });
  const [no, yes] = await page.locator('.consent-btns button').all();
  const look = (b) => b.evaluate((e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, c.borderColor, c.fontWeight, e.getBoundingClientRect().height]; });
  expect(await look(no)).toEqual(await look(yes));
  await expect(page.locator('.consent-bar a', { hasText: 'Privacy' })).toBeVisible();
  await no.click();
  await expect.poll(() => logged).not.toBeNull();
  expect(logged).toMatchObject({ kind: 'analytics', granted: false, text_version: 'v2' });
});

test('making an account says it is for people 18 and over', async ({ page }) => {
  await boot(page);
  const ok = await page.evaluate(() => typeof window.meOpenAuth === 'function');
  test.skip(!ok, 'no account sign-up in this build');
  await page.evaluate(() => window.meOpenAuth('signup'));
  await expect(page.getByText(/18 or over/)).toBeVisible();
});

test('switching on a paid feature takes back every "no commission" line, and How we rank plans says so', async ({ page }) => {
  await page.addInitScript(() => { window.__SAWED_FEATURES = { partners: true }; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, { onboarding_complete: false, current_screen: 'welcome' }, '/');
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  const front = await page.locator('body').innerText();
  expect(front).not.toMatch(/no commission/i);
  await page.evaluate(() => window.setScreen('independence'));
  await expect(page.locator('body')).not.toContainText('No supplier pays us');
  await page.evaluate(() => window.setScreen('ranking'));
  await expect(page.locator('.privacy-copy')).toContainText('Every plan or quote that touches is marked');
});

test('the figures are called estimates, never exact', async ({ page }) => {
  await boot(page);
  const words = [];
  for (const s of ['result', 'more', 'methodology', 'csv-import', 'everything', 'terms']) {
    await page.evaluate((x) => window.setScreen(x), s);
    words.push(await page.locator('body').innerText());
  }
  for (const t of ['solar', 'accuracy']) {
    await page.evaluate((x) => { window.setScreen('analytics'); window.anTab(x); }, t);
    words.push(await page.locator('body').innerText());
  }
  const all = words.join('\n');
  expect(all).not.toMatch(/\bexact (figures|answer)|most exact|most accurate figures|instead of an estimate|Calculations are/i);
  expect(all).toMatch(/estimate/i);
});

test('Home names the cheapest plan as the cheapest, and says the solar figures are at today’s prices', async ({ page }) => {
  await boot(page, { has_solar: true, solar_planned: false, considering_solar: true, count_A: 10, panel_w: 440, azimuth_A: 180, tilt_A: 35, battery_kwh: 5, current_screen: 'result' });
  await page.evaluate(() => window.setScreen('result'));
  const home = page.locator('.screen').first();
  await expect(home).not.toContainText('Best for your home');
  await expect(page.locator('.hc').first()).toContainText('at today’s prices');
  // The page's name in a browser tab or a shared link isn't "advisor".
  expect(await page.title()).not.toMatch(/advis/i);
});

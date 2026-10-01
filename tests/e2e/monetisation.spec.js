import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const SOLAR = { has_solar: true, considering_solar: true, count_A: 12, battery_kwh: 5, current_screen: 'solar' };

test('a quote request needs consent, then goes to the server with the modelled system', async ({ page }) => {
  const errors = await boot(page, SOLAR);
  let sent = null;
  await page.route('**/api/lead', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, matched: 2 }) });
  });
  await page.evaluate(() => window.openLeadForm());
  await page.fill('#lead-email', 'home@example.ie');
  await page.selectOption('#lead-county', 'Cork');
  await page.click('#lead-submit');
  await expect(page.locator('#lead-error')).toContainText('Tick the box');
  expect(sent).toBeNull();
  await page.check('#lead-consent');
  await page.click('#lead-submit');
  await expect(page.locator('#lead-modal')).toHaveCount(0);
  expect(sent.consent_share).toBe(true);
  expect(sent.county).toBe('Cork');
  expect(sent.spec.panels).toBe(12);
  expect(sent.spec.battery_kwh).toBe(5);
  expect(errors).toEqual([]);
});

test('usage measurement is asked once, and nothing is sent before a yes', async ({ page }) => {
  const calls = [];
  await boot(page, { askConsent: true });
  await page.route('**/api/event', (r) => { calls.push(r.request().postDataJSON()); r.fulfill({ status: 200, body: '{}' }); });
  await page.route('**/api/consent', (r) => r.fulfill({ status: 200, body: '{}' }));
  await expect(page.locator('.consent-bar')).toBeVisible();
  await page.evaluate(() => window.handleSwitchClick('EI-24', 'x', 100));
  expect(calls.length).toBe(0);
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.locator('.consent-bar')).toHaveCount(0);
  await page.evaluate(() => window.handleSwitchClick('EI-24', 'x', 100));
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].name).toBe('switch_click');
  expect(calls[0].click_id).toBeTruthy();
});

test('commission never changes the ranking', async ({ page }) => {
  await boot(page);
  const without = await page.evaluate(() => window.getRecommendation().ranked.map((r) => r.plan.id));
  await page.addInitScript((ids) => { window.__SAWED_PARTNERS = ids; }, without.slice(-5));
  await boot(page);
  const withPartners = await page.evaluate(() => window.getRecommendation().ranked.map((r) => r.plan.id));
  expect(withPartners).toEqual(without);
  const last = without[without.length - 1];
  expect(await page.evaluate((id) => window.isPartnerPlan(id), last)).toBe(true);
});

test('privacy page and installer portal are reachable from More', async ({ page }) => {
  await boot(page, { current_screen: 'more' });
  await page.getByText('Privacy and your data').click();
  await expect(page.locator('.privacy-copy')).toContainText('installer');
  await page.evaluate(() => window.setScreen('installer'));
  await expect(page.getByText(/Installers partnered with Sawed|Accounts are not available/)).toBeVisible();
});

test('the consent box is a real, visible checkbox', async ({ page }) => {
  await boot(page, SOLAR);
  await page.evaluate(() => window.openLeadForm());
  const box = page.locator('#lead-consent');
  const look = await box.evaluate((el) => { const cs = getComputedStyle(el); return { app: cs.appearance || cs.webkitAppearance, w: el.getBoundingClientRect().width }; });
  expect(look.app).not.toBe('none');
  expect(look.w).toBeGreaterThan(12);
  // Tapping the words ticks it too.
  await page.locator('.lead-consent span').click();
  await expect(box).toBeChecked();
});

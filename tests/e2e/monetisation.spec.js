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
  await page.locator('.more-fold summary').click();
  await page.getByText('Privacy and your data').click();
  await expect(page.locator('.privacy-copy')).toContainText('installer');
  await page.evaluate(() => window.setScreen('installer'));
  await expect(page.getByText(/Installers who work with Peakless|Accounts are not available/)).toBeVisible();
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

test('the switch button speaks in two voices, equally prominent, and both explain before leaving', async ({ page }) => {
  await boot(page, { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0, baseline: 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY' });
  const best = await page.evaluate(() => window.getRecommendation().best.plan);
  const btn = page.locator('.v7-hero ~ .v7-switch-btn, .v7-switch-btn').first();
  await expect(btn).toContainText(`Switch on ${best.supplier}'s website`);
  const plainBox = await btn.boundingBox();
  await btn.click();
  await expect(page.locator('#v7-sheet')).toContainText('Pick exactly this plan');
  await expect(page.locator('#v7-sheet')).toContainText('Peakless earns nothing from this switch');

  await page.addInitScript((id) => { window.__SAWED_PARTNERS = [id]; }, best.id);
  await boot(page, { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0, baseline: 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY' });
  const pbtn = page.locator('.v7-switch-btn').first();
  await expect(pbtn).toContainText('Switch with Peakless');
  const partnerBox = await pbtn.boundingBox();
  expect(Math.abs(partnerBox.height - plainBox.height)).toBeLessThan(2);   // same prominence
  await pbtn.click();
  await expect(page.locator('#v7-sheet')).toContainText('pays Peakless if you switch');
});

test('sending the quote form again updates the request', async ({ page }) => {
  await boot(page, { ...SOLAR, _lead_form: { email: 'h@x.ie', county: 'Cork', sent_at: '2026-10-01T12:00:00Z' } });
  await page.route('**/api/lead', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, updated: true, matched: 2 }) }));
  await page.evaluate(() => window.openLeadForm());
  await expect(page.locator('#lead-modal')).toContainText('Update your quote request');
  await page.check('#lead-consent');
  await page.click('#lead-submit');
  await expect(page.getByText(/Updated\. The installers already looking at it/)).toBeVisible();
});

test('privacy notice: who, what and how long, who receives it, rights, and a data download', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'privacy' });
  const copy = page.locator('.privacy-copy');
  for (const h of ['Who we are', 'What we hold, why, and for how long', 'Who receives it', 'Your rights']) await expect(copy.locator('h3', { hasText: h })).toBeVisible();
  // Retention periods match the database purge (supabase/security_2026_10.sql).
  for (const k of ['24 months', '26 months', '36 months', '1 day']) await expect(copy.locator('.privacy-table')).toContainText(k);
  await expect(copy).toContainText('Data Protection Commission');
  const dl = page.waitForEvent('download');
  await page.locator('.secondary-card', { hasText: 'Download my data' }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe('peakless-my-data.json');
  const body = JSON.parse(await (await import('node:fs')).promises.readFile(await file.path(), 'utf8'));
  expect(body.on_this_phone).toBeTruthy();
  expect(errors).toEqual([]);
});

/**
 * Independence and personal data. Quote requests to installers, partner
 * suppliers and email capture are built but switched off for the first
 * launch (src/features.js). The first group checks nothing of them shows; the
 * second switches each on, as a later release would, and checks it still works.
 */
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const SOLAR = { has_solar: true, considering_solar: true, count_A: 12, battery_kwh: 5, current_screen: 'solar' };
/** Switch parts on before the app loads, as a later release would in src/features.js. */
const switchOn = (page, f) => page.addInitScript((x) => { window.__SAWED_FEATURES = x; }, f);

test.describe('first launch: switched off', () => {
  test('usage measurement is asked once, and nothing is sent or loaded before a yes', async ({ page }) => {
    const calls = [], counter = [];
    page.on('request', (r) => { if (r.url().includes('/_vercel/insights')) counter.push(r.url()); });
    await boot(page, { askConsent: true });
    await page.route('**/api/event', (r) => { calls.push(r.request().postDataJSON()); r.fulfill({ status: 200, body: '{}' }); });
    await page.route('**/api/consent', (r) => r.fulfill({ status: 200, body: '{}' }));
    await expect(page.locator('.consent-bar')).toBeVisible();
    await page.evaluate(() => { window.open = () => null; window.handleSwitchClick('EI-24', 'x', 100); });
    expect(calls.length).toBe(0);
    expect(counter).toEqual([]);                       // Vercel's page counter waits for a yes too
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.locator('.consent-bar')).toHaveCount(0);
    await page.evaluate(() => window.handleSwitchClick('EI-24', 'x', 100));
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].name).toBe('switch_click');
    expect(calls[0].click_id).toBeNull();              // no click ID for a supplier to report back on
    expect(Object.keys(calls[0].props).sort()).toEqual(['plan_id', 'savings_eur']);
    await expect.poll(() => counter.length).toBe(1);
  });

  test('the switch button opens the supplier’s own page, with nothing added to the link', async ({ page }) => {
    await boot(page, { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0, baseline: 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY' });
    const best = await page.evaluate(() => window.getRecommendation().best.plan);
    const btn = page.locator('.v7-switch-btn').first();
    await expect(btn).toContainText(`Switch on ${best.supplier}'s website`);
    await btn.click();
    const sheet = page.locator('#v7-sheet');
    await expect(sheet).toContainText('Pick exactly this plan');
    await expect(sheet).toContainText('Peakless earns nothing from this switch');
    await expect(sheet).not.toContainText(/commission|pays Peakless/i);
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    await sheet.locator('.switch-cta').first().click();
    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toEqual([best.source.url]);
    expect(opened[0]).not.toMatch(/utm_|sawed_click|referral/);
  });

  test('a partner list has no effect while partners are switched off', async ({ page }) => {
    await page.addInitScript(() => { window.__SAWED_PARTNERS = ['EI-24', 'EI-SST', 'EI-NB']; });
    await boot(page);
    expect(await page.evaluate(() => window.isPartnerPlan('EI-24'))).toBe(false);
  });

  test('every plan a home can switch to has a supplier page to open', async ({ page }) => {
    await boot(page);
    const missing = await page.evaluate(() => window.getRecommendation().ranked
      .filter((r) => !(r.plan.source && /^https:\/\//.test(r.plan.source.url))).map((r) => r.plan.id));
    expect(missing).toEqual([]);
  });

  test('nothing offers installer quotes, and the installer portal is hidden', async ({ page }) => {
    const errors = await boot(page, { current_screen: 'analytics', solar_planned: true, _an_tab: 'solar' });
    await page.evaluate(() => { window.anTab('solar'); });
    await expect(page.locator('#app-root')).not.toContainText(/Get 3 quotes|match you with|installer quotes for your/i);
    await expect(page.locator('.ax-cta', { hasText: 'Check an installer’s quote' })).toBeVisible();
    await page.evaluate(() => window.setScreen('more'));
    await page.locator('.more-fold summary').click();
    await expect(page.locator('#app-root')).not.toContainText('Installer portal');
    await page.evaluate(() => window.setScreen('installer'));
    await expect(page.getByText(/Installers who work with Peakless/)).toHaveCount(0);
    await page.evaluate(() => window.setScreen('updates'));
    await expect(page.locator('.section-title', { hasText: 'Quote requests' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('contact details kept for a switched-off part are cleared on load', async ({ page }) => {
    await boot(page, {
      lead_queue: [{ email: 'old@example.ie', source: 'pdf_report', address: '1 Main St' }],
      user_email: 'old@example.ie', email_captured: true,
      _lead_form: { email: 'old@example.ie', county: 'Cork', phone: '0870000000' },
    });
    const left = await page.evaluate(() => {
      window.saveState();
      const saved = JSON.parse(localStorage.getItem('solarAppState_v2'));
      return ['lead_queue', 'user_email', 'email_captured', '_lead_form'].filter((k) => k in window.state || k in saved);
    });
    expect(left).toEqual([]);
  });

  test('the report downloads without asking for an email', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.openPdfReportModal());
    const modal = page.locator('#pdf-modal');
    await expect(modal).toContainText('Download your report');
    await expect(modal.locator('input')).toHaveCount(0);
    await expect(modal).not.toContainText(/email app|Email me/i);
  });

  test('privacy and terms are reachable from More, the footer and a plain link', async ({ page }) => {
    await boot(page, { current_screen: 'more' });
    await page.locator('.more-fold summary').click();
    await page.getByText('Privacy and your data').click();
    await expect(page.locator('.privacy-copy')).toContainText('We don’t pass your details to suppliers or installers');
    await page.locator('.privacy-copy a', { hasText: 'terms of use' }).click();
    await expect(page.locator('.privacy-copy h3', { hasText: 'What the figures are' })).toBeVisible();

    // A first-time visitor following a link lands on the page, not the front page.
    await page.evaluate(() => localStorage.clear());
    await page.goto('/#terms');
    await page.waitForFunction(() => !document.getElementById('loader'));
    await expect(page.locator('.privacy-copy')).toContainText('isn’t a regulated financial or energy adviser');
    await page.goto('/#privacy');
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loader'));
    await expect(page.locator('.privacy-copy h3', { hasText: 'Who receives it' })).toBeVisible();
  });

  test('the front-page footer links to privacy and terms for a first-time visitor, and claims nothing untrue about data', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = await boot(page, { onboarding_complete: false, current_screen: 'welcome' }, '/');
    await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
    const foot = page.locator('footer.wl-foot').first();
    await expect(foot).not.toContainText('stays on your device');
    await foot.getByRole('link', { name: 'Terms' }).click();
    await expect(page.locator('.privacy-copy h3', { hasText: 'Fair use' })).toBeVisible();
    await page.evaluate(() => window.setScreen('welcome'));
    await page.locator('footer.wl-foot').first().getByRole('link', { name: 'Privacy' }).click();
    await expect(page.locator('.privacy-copy h3', { hasText: 'Who receives it' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('privacy notice: who, what and how long, who receives it, rights, and a data download', async ({ page }) => {
    const errors = await boot(page, { current_screen: 'privacy' });
    const copy = page.locator('.privacy-copy');
    for (const h of ['Who we are', 'What we hold, why, and for how long', 'Who receives it', 'Your rights']) await expect(copy.locator('h3', { hasText: h })).toBeVisible();
    // Retention periods match the database purge (supabase/security_2026_10.sql).
    for (const k of ['26 months', '36 months', '1 day', '30 days']) await expect(copy.locator('.privacy-table')).toContainText(k);
    await expect(copy).not.toContainText(/Quote request|up to three/i);
    await expect(copy.locator('.privacy-table')).toContainText('meter readings');
    await expect(copy).toContainText('Data Protection Commission');
    const dl = page.waitForEvent('download');
    await page.locator('.secondary-card', { hasText: 'Download my data' }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toBe('peakless-my-data.json');
    const body = JSON.parse(await (await import('node:fs')).promises.readFile(await file.path(), 'utf8'));
    expect(body.on_this_phone).toBeTruthy();
    expect(errors).toEqual([]);
  });
});

test.describe('a later release: switched on', () => {
  test('a quote request needs consent, then goes to the server with the modelled system', async ({ page }) => {
    await switchOn(page, { installerQuotes: true });
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

  test('the Solar tab offers 3 quotes, and the privacy page says who receives a request', async ({ page }) => {
    await switchOn(page, { installerQuotes: true });
    await boot(page, { current_screen: 'analytics', solar_planned: true, _an_tab: 'solar' });
    await page.evaluate(() => { window.anTab('solar'); });
    await expect(page.locator('.ax-cta', { hasText: 'Get 3 quotes for this system' })).toBeVisible();
    await page.evaluate(() => window.setScreen('privacy'));
    await expect(page.locator('.privacy-copy')).toContainText('up to three SEAI-registered installers');
    await expect(page.locator('.privacy-table')).toContainText('24 months');
  });

  test('commission never changes the ranking', async ({ page }) => {
    await boot(page);
    const without = await page.evaluate(() => window.getRecommendation().ranked.map((r) => r.plan.id));
    await switchOn(page, { partners: true });
    await page.addInitScript((ids) => { window.__SAWED_PARTNERS = ids; }, without.slice(-5));
    await boot(page);
    const withPartners = await page.evaluate(() => window.getRecommendation().ranked.map((r) => r.plan.id));
    expect(withPartners).toEqual(without);
    const last = without[without.length - 1];
    expect(await page.evaluate((id) => window.isPartnerPlan(id), last)).toBe(true);
  });

  test('privacy page and installer portal are reachable from More', async ({ page }) => {
    await switchOn(page, { installerQuotes: true });
    await boot(page, { current_screen: 'more' });
    await page.locator('.more-fold summary').click();
    await expect(page.getByText('Installer portal')).toBeVisible();
    await page.getByText('Privacy and your data').click();
    await expect(page.locator('.privacy-copy')).toContainText('installer');
    await page.evaluate(() => window.setScreen('installer'));
    await expect(page.getByText(/Installers who work with Peakless|Accounts are not available/)).toBeVisible();
  });

  test('the consent box is a real, visible checkbox', async ({ page }) => {
    await switchOn(page, { installerQuotes: true });
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
    const HOME = { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0, baseline: 'BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY' };
    await switchOn(page, { partners: true });
    await boot(page, HOME);
    const best = await page.evaluate(() => window.getRecommendation().best.plan);
    const btn = page.locator('.v7-hero ~ .v7-switch-btn, .v7-switch-btn').first();
    await expect(btn).toContainText(`Switch on ${best.supplier}'s website`);
    const plainBox = await btn.boundingBox();
    await btn.click();
    await expect(page.locator('#v7-sheet')).toContainText('Pick exactly this plan');
    await expect(page.locator('#v7-sheet')).toContainText('Peakless earns nothing from this switch');

    await page.addInitScript((id) => { window.__SAWED_PARTNERS = [id]; }, best.id);
    await boot(page, HOME);
    const pbtn = page.locator('.v7-switch-btn').first();
    await expect(pbtn).toContainText('Switch with Peakless');
    const partnerBox = await pbtn.boundingBox();
    expect(Math.abs(partnerBox.height - plainBox.height)).toBeLessThan(2);   // same prominence
    await pbtn.click();
    await expect(page.locator('#v7-sheet')).toContainText('pays Peakless if you switch');
  });

  test('sending the quote form again updates the request', async ({ page }) => {
    await switchOn(page, { installerQuotes: true });
    await boot(page, { ...SOLAR, _lead_form: { email: 'h@x.ie', county: 'Cork', sent_at: '2026-10-01T12:00:00Z' } });
    await page.route('**/api/lead', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, updated: true, matched: 2 }) }));
    await page.evaluate(() => window.openLeadForm());
    await expect(page.locator('#lead-modal')).toContainText('Update your quote request');
    await page.check('#lead-consent');
    await page.click('#lead-submit');
    // The toast, not the screen-reader copy of it that can carry the same words.
    await expect(page.locator('#toast-stack').getByText(/Updated\. The installers already looking at it/)).toBeVisible();
  });

  test('with email capture on, the report keeps the address given and makes the PDF once', async ({ page }) => {
    await switchOn(page, { emailCapture: true });
    await page.setViewportSize({ width: 1440, height: 900 });   // a computer: the PDF downloads
    await boot(page);
    const files = [];
    page.on('download', (d) => files.push(d.suggestedFilename()));
    await page.evaluate(() => window.openPdfReportModal());
    await page.fill('#pdf-email', 'home@example.ie');
    await page.click('#pdf-submit-btn');
    await expect.poll(() => files.length, { timeout: 30000 }).toBe(1);
    await page.waitForTimeout(1500);
    expect(files.length).toBe(1);
    expect(await page.evaluate(() => window.state.lead_queue.map((l) => l.email))).toEqual(['home@example.ie']);
  });
});

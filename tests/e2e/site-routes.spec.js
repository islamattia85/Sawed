// @ts-check
import { test, expect } from '@playwright/test';
import { isolate, boot } from './support.js';

/** A returning visitor's first way in shows the saved home; carry on with it. */
async function confirmHome(page) {
  await expect(page.getByRole('dialog', { name: 'Is this your home?' })).toBeVisible();
  await page.getByRole('button', { name: 'Yes, carry on' }).click();
}

// Every way in on the front page lands where its label says. A new visitor
// starts setup on the question the button promised, with setup naming what
// it is for; someone with an answer goes to the matching part of it.
const WAYS = [
  ['thinking about solar', 'Does solar pay on your home?', 'Where in Ireland is the home?'],
  ['They told me five years', 'Does solar pay on your home?', 'Where in Ireland is the home?'],
  ['Is it the right system for my roof', 'Does solar pay on your home?', 'Where in Ireland is the home?'],
  ['Is my quote fair', 'Checking your quote', 'How many panels are on the quote?'],
  ['What if export pay drops', 'What if prices change?', 'Where in Ireland is the home?'],
  ['I have solar. Am I on the right plan', 'Getting the most from your panels', 'Where in Ireland is the home?'],
  ['I have solar', 'Getting the most from your panels', 'Where in Ireland is the home?'],
  ['getting an electric car', 'What a car means for your bill', 'How far do you drive in a year?'],
  ['I just want a cheaper plan', 'Comparing every plan on your home', 'What’s your electricity bill?'],
  ['Just a better plan', 'Comparing every plan on your home', 'What’s your electricity bill?'],
  ['Check my home', 'Checking your home', 'What’s your electricity bill?'],
];

for (const [button, route, question] of WAYS) {
  test(`new visitor: "${button}" opens setup on its own first question`, async ({ page }) => {
    await isolate(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
    await page.reload();
    await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
    // Scroll down first: setup must still open at its top.
    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.getByRole('button', { name: button }).first().click();
    await page.waitForFunction(() => window.state.current_screen === 'flow');
    await expect(page.locator('.fl-route b')).toHaveText(route);
    await expect(page.locator('.fl-q h2')).toHaveText(question);
    await expect(page.locator('.fl-step-k')).toContainText('Part 1 of');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(10);
    expect(await page.evaluate(() => window.state.onboarding_complete)).toBeFalsy();
  });
}

test('the quote route never invents a home: nothing is set up until setup is finished', async ({ page }) => {
  await isolate(page);
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
  await page.getByRole('button', { name: 'Is my quote fair' }).click();
  await page.waitForFunction(() => window.state.current_screen === 'flow');
  expect(await page.evaluate(() => window.state.onboarding_complete)).toBeFalsy();
  await page.locator('.fl-exit').click();
  await expect(page.locator('.wl-site')).toBeVisible();
  // Still a new visitor: the header offers a check, not "My answer".
  await expect(page.locator('.wl-bar .wl-btn-p')).toHaveText('Check my home');
});

test('the quote route ends on whether the price is fair', async ({ page }) => {
  await isolate(page);
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
  await page.evaluate(() => {
    siteGo('quote');
    flowAnswer('panels', 12); flowAnswer('battery', 0); flowAnswer('price', 30000); flowAnswer('grant', 'yes');
    flowAnswer('where', 'east'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35);
    flowAnswer('bill', 250); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0);
    flowAnswer('heat', 'gas'); flowAnswer('gas', 'no'); flowAnswer('night', 'no'); flowAnswer('ev', 'no');
  });
  await expect(page.locator('.fl-r-quote b')).toContainText('high');
  await page.locator('.fl-go').click();
  expect(await page.evaluate(() => window.state.current_screen)).toBe('solar');
});

const ANSWERED = [
  ['They told me five years', 'solar'],
  ['Is my quote fair', 'solar'],
  ['What if export pay drops', 'flow'],
  ['Just a better plan', 'plans'],
  ['getting an electric car', 'ev-guide'],
];
for (const [button, screen] of ANSWERED) {
  test(`returning visitor: "${button}" goes to the matching page, not back to the first question`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await boot(page, { current_screen: 'welcome', has_solar: false, considering_solar: false, ev_active: false }, '/');
    await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
    await page.getByRole('button', { name: button }).first().click();
    await confirmHome(page);
    await page.waitForFunction((s) => window.state.current_screen === s, screen);
    if (button === 'Is my quote fair') await expect(page.locator('#v7-sheet')).toContainText('quote');
    if (button === 'What if export pay drops') await expect(page.locator('.fl-route b')).toHaveText('What if prices change?');
  });
}

test('returning visitor with no panels on file: "I have panels" asks only about the panels, and leaving changes nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page, { current_screen: 'welcome', has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0, region_asked: true }, '/');
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  const before = await page.evaluate(() => ({ s: window.state.has_solar, n: window.state.count_A }));
  await page.getByRole('button', { name: 'I have solar. Am I on the right plan' }).first().click();
  await confirmHome(page);
  await page.waitForFunction(() => window.state.current_screen === 'flow');
  await expect(page.locator('.fl-q h2')).toHaveText('Which way does the roof face?');
  await expect(page.locator('.fl-step-k')).toContainText('Part 1 of');
  await page.locator('.fl-exit').click();
  const after = await page.evaluate(() => ({ s: window.state.has_solar, n: window.state.count_A }));
  expect(after).toEqual(before);
});

test('the "How it works" link goes to how it works', async ({ page }) => {
  await isolate(page);
  await page.goto('/');
  await expect(page.locator('#how')).toContainText('Tell us about your home');
});

test('the front page’s figures are the model’s: the hero bars read from the figures file', async ({ page }) => {
  const fig = JSON.parse((await import('node:fs')).readFileSync(new URL('../../src/data/front-figures.json', import.meta.url), 'utf8'));
  await isolate(page);
  await page.goto('/');
  const L = fig.big.ladder, eur = (v) => `€${Math.round(v).toLocaleString('en-IE')}`;
  const bars = page.locator('.wl-hero .wl-pb-row em');
  await expect(bars).toHaveText([L.now, L.switch, L.solar_stay, L.solar_best].map(eur));
  await expect(page.locator('.wl-hero .wl-pb-note')).toContainText(`${L.stay_payback.toFixed(1)} years on the old plan, ${L.best_payback.toFixed(1)}`);
  await expect(page.locator('#plan')).toContainText(`${fig.big.gone_payback.toFixed(1)} years`);
});

test('returning visitor with a system: "What if export pay drops" opens the stress test itself', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await boot(page, { current_screen: 'welcome', has_solar: true, solar_planned: true, count_A: 12, battery_kwh: 0 }, '/');
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  await page.getByRole('button', { name: 'What if export pay drops' }).click();
  await confirmHome(page);
  await page.waitForFunction(() => window.state.current_screen === 'solar');
  await expect(page.locator('#stress-card')).toBeInViewport({ timeout: 10000 });
});

test('returning visitor: the first way in shows the saved home, and only once a visit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { current_screen: 'welcome', bimonthly_bill_eur: 250, heating_type: 'gas', has_solar: false }, '/');
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  await page.getByRole('button', { name: 'Just a better plan' }).click();
  const dlg = page.getByRole('dialog', { name: 'Is this your home?' });
  await expect(dlg).toContainText('Gas or oil');
  await expect(dlg).toContainText('No panels');
  // Nothing is opened until they say it's theirs.
  expect(await page.evaluate(() => window.state.current_screen)).toBe('welcome');
  await page.getByRole('button', { name: 'Yes, carry on' }).click();
  await page.waitForFunction(() => window.state.current_screen === 'plans');
  // Back on the front page, the next way in goes straight through.
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  await page.getByRole('button', { name: 'I just want a cheaper plan' }).or(page.getByRole('button', { name: 'My plans' })).first().click();
  await expect(page.getByRole('dialog', { name: 'Is this your home?' })).toHaveCount(0);
  await page.waitForFunction(() => window.state.current_screen === 'plans');
});

test('returning visitor: "Not my home" clears the saved answers and starts setup on the same question', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { current_screen: 'welcome', bimonthly_bill_eur: 200, heating_type: 'gas' }, '/');
  await page.evaluate(() => { window.state.current_screen = 'welcome'; window.renderApp(); });
  await page.getByRole('button', { name: 'Is my quote fair' }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Not my home: start again' }).click();
  await page.waitForFunction(() => window.state.current_screen === 'flow');
  await expect(page.locator('.fl-route b')).toHaveText('Checking your quote');
  expect(await page.evaluate(() => window.state.onboarding_complete)).toBeFalsy();
});

test('a home the old quote screen made up is not treated as the visitor’s own', async ({ page }) => {
  await boot(page, { current_screen: 'result', auditor_entry: true, bimonthly_bill_eur: 200 }, '/');
  expect(await page.evaluate(() => window.state.onboarding_complete)).toBeFalsy();
  await expect(page.locator('.wl-bar .wl-btn-p')).toHaveText('Check my home');
});

test('on a phone the questions swipe sideways instead of stacking', async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('.wl-asks').waitFor();
  const m = await page.evaluate(() => { const r = document.querySelector('.wl-asks'); const rows = [...r.children].map((c) => c.getBoundingClientRect()); return { h: r.getBoundingClientRect().height, scroll: r.scrollWidth > r.clientWidth, sameRow: rows.every((x) => Math.abs(x.top - rows[0].top) < 2) }; });
  expect(m.scroll).toBe(true);
  expect(m.sameRow).toBe(true);
  expect(m.h).toBeLessThan(400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('a home someone set up keeps its answers, even if they once used the old quote screen', async ({ page }) => {
  await boot(page, { current_screen: 'result', auditor_entry: true, meter_type: 'smart' }, '/');
  expect(await page.evaluate(() => window.state.onboarding_complete)).toBe(true);
});

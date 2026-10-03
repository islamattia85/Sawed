import { test, expect } from '@playwright/test';
import { boot, bootFresh } from './support.js';

/**
 * Journeys, not screens: where a tap lands, where Back goes, and that a
 * promise ("+30 points", "Switch") leads to what it promised. Written after a
 * crawl of every button on every screen found journeys that went sideways.
 */

const screen = (page) => page.evaluate(() => window.state.current_screen);

test('the phone Back gesture steps back through the first-visit flow and never leaves the app', async ({ page }) => {
  await bootFresh(page);
  await page.getByRole('button', { name: /Get started/ }).click();
  expect(await screen(page)).toBe('flow');
  await page.goBack();
  await expect.poll(() => screen(page)).toBe('welcome');
  expect(page.url()).toContain('127.0.0.1');
});

test('Back inside the solar guide goes one step back, then closes it where it was opened', async ({ page }) => {
  await boot(page, { current_screen: 'solar', has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  await page.getByRole('button', { name: /Estimate it for my roof/ }).click();
  await page.locator('.sg-tile', { hasText: 'South' }).first().click();            // step 2
  await page.getByRole('button', { name: /^Next/ }).click();                        // step 3
  expect(await page.evaluate(() => window.state._sg)).toBe(3);
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.state._sg)).toBe(2);
  await page.goBack(); await page.goBack();                                         // 1, out
  await expect.poll(() => screen(page)).toBe('solar');
  // Leaving the guide leaves no system behind.
  expect(await page.evaluate(() => window.state.has_solar)).toBe(false);
});

test('Back inside the EV guide steps back, and out of it leaves the home as it was', async ({ page }) => {
  await boot(page, { ev_active: false, ev_km_per_year: 0 });
  await page.evaluate(() => window.startEvGuide());
  await page.locator('.sg-opt', { hasText: 'thinking about one' }).click();         // step 2
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.state._eg)).toBe(1);
  await page.goBack();
  await expect.poll(() => screen(page)).toBe('result');
  expect(await page.evaluate(() => window.state.ev_active)).toBe(false);
});

test('every switch button opens the same "before you switch" panel, from any screen', async ({ page }) => {
  for (const scr of ['result', 'solar', 'monitor']) {
    await boot(page, { current_screen: scr });
    const btn = page.locator('.switch-cta').filter({ hasText: /Switch/ }).first();
    if (!(await btn.count())) continue;
    await btn.click();
    await expect(page.locator('#v7-sheet'), `${scr}: switch skipped the panel`).toBeVisible();
    expect(await page.evaluate(() => window.state._sheet.kind)).toBe('switch');
  }
});

test('a challenge is explained before it starts, and finishing it says what was earned', async ({ page }) => {
  await boot(page, { current_screen: 'me', contract_end: null });
  const quest = page.locator('.gm-q', { hasText: 'contract end date' });
  await quest.click();
  const sheet = page.locator('#v7-sheet');
  await expect(sheet).toContainText('Challenge');
  await expect(sheet).toContainText('Do it now');
  await sheet.getByRole('button', { name: /Do it now/ }).click();
  await expect(page.locator('#v7-sheet')).toContainText('My home');   // the place to do it
});

test('a rising score is announced with the points earned', async ({ page }) => {
  await boot(page, { current_screen: 'me', baseline: 'EI-24', chosen_plan: null });
  await page.waitForTimeout(900);
  const best = await page.evaluate(() => window.getRecommendation().cheapest.plan.id);
  await page.evaluate((id) => { window.state.baseline = id; window.invalidate(); window.renderApp(); }, best);
  await expect(page.locator('.toast, .v7-toast').filter({ hasText: /points/ })).toBeVisible({ timeout: 4000 });
});

test('no tap on the four tabs throws an error or leaves the app', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page, { has_solar: true, considering_solar: true, solar_planned: true, count_A: 12, battery_kwh: 5, ev_active: true, ev_km_per_year: 15000 });
  await page.evaluate(() => { window.open = () => null; });
  for (const scr of ['result', 'plans', 'analytics', 'me']) {
    const n = await page.evaluate((s) => { window.state._sheet = null; window.setScreen(s);
      return document.querySelectorAll('#app-root .screen button').length; }, scr);
    for (let i = 0; i < Math.min(n, 30); i++) {
      const label = await page.evaluate(([s, i]) => {
        window.state._sheet = null; window.state.current_screen = s; window.renderApp();
        const b = document.querySelectorAll('#app-root .screen button')[i];
        if (!b) return null;
        const t = (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40);
        if (/Reset|Sign out|Delete|Re-run setup/i.test(t)) return t + ' (skipped)';
        b.click(); return t;
      }, [scr, i]);
      await page.waitForTimeout(60);
      expect(page.url(), `${scr} · "${label}" left the app`).toContain('127.0.0.1');
    }
  }
  expect(errors).toEqual([]);
});

test('"Do it now" acts where you are: no challenge sends you to another tab', async ({ page }) => {
  const days = {};
  for (let i = 0; i < 30; i++) { const d = new Date(Date.now() - (30 - i) * 864e5).toISOString().slice(0, 10);
    days[d] = [...Array.from({ length: 24 }, (_, h) => (h >= 17 && h < 19 ? 2 : 0.5)), ...new Array(24).fill(0)]; }
  for (const st of [{}, { baseline: 'EN-SMART', meter: { days } }]) {
    await boot(page, { current_screen: 'me', contract_end: '2027-06-01', ...st });
    const quests = await page.locator('.gm-q').count();
    for (let i = 0; i < quests; i++) {
      await page.evaluate(() => { window.state._sheet = null; window.state.current_screen = 'me'; window.renderApp(); });
      await page.locator('.gm-q').nth(i).click();
      await page.locator('#v7-sheet').getByRole('button', { name: /Do it now/ }).click();
      await page.waitForTimeout(150);
      const where = await page.evaluate(() => [window.state.current_screen, window.state._sheet && window.state._sheet.kind]);
      expect(where[0], `challenge ${i} left My Peakless for ${where[0]}`).toBe('me');
      expect(where[1], `challenge ${i} opened nothing`).toBeTruthy();
    }
  }
});

test('the meter challenge uploads in place and stays on My Peakless', async ({ page }) => {
  await boot(page, { current_screen: 'me' });
  await page.locator('.gm-q', { hasText: 'ESB meter file' }).click();
  await page.locator('#v7-sheet').getByRole('button', { name: /Do it now/ }).click();
  await expect(page.locator('#v7-sheet')).toContainText('myaccount.esbnetworks.ie');
  await expect(page.locator('#v7-sheet #csv-file-input')).toHaveCount(1);
});

test('a file uploaded from the challenge is applied, and you are still on My Peakless', async ({ page }) => {
  await boot(page, { current_screen: 'me' });
  await page.evaluate(() => window.v7Sheet('meter'));
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  for (let d = 1; d <= 28; d++) for (let h = 0; h < 24; h++)
    rows.push(`1,2,${h >= 17 && h < 19 ? 2 : 0.6},Active Import Interval (kW),${String(d).padStart(2, '0')}-09-2026 ${String(h).padStart(2, '0')}:30`);
  await page.locator('#csv-file-input').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await page.getByRole('button', { name: /Use this data/ }).click();
  await expect.poll(() => page.evaluate(() => [window.state.current_screen, !!window.state._sheet, !!window.state._csv_imported])).toEqual(['me', false, true]);
});

test('opening solar from Home and backing out leaves Home exactly as it was', async ({ page }) => {
  await boot(page, { current_screen: 'result', has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  const before = await page.locator('.v7-basis-line').textContent();
  await page.getByRole('button', { name: /Thinking about solar/ }).click();
  await expect(page.locator('.sg-h')).toContainText('Which way does your roof face');   // straight to the first question
  await page.locator('.sg-tile', { hasText: 'South' }).first().click();
  await page.goBack(); await page.goBack();
  await expect.poll(() => screen(page)).toBe('result');
  expect(await page.evaluate(() => [window.state.has_solar, window.state.count_A])).toEqual([false, 0]);
  expect(await page.locator('.v7-basis-line').textContent()).toBe(before);
});

test('the first visit asks for the supplier, then that supplier\'s plan', async ({ page }) => {
  await page.goto('/?fresh'); await page.waitForFunction(() => window.__bootSettled === true);
  await page.getByRole('button', { name: /Get started/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('.fl-sup', { hasText: 'Energia' }).click();
  const plans = await page.locator('.fl-opt').allTextContents();
  expect(plans.length).toBeGreaterThan(2);                                            // its plans…
  expect(plans.at(-1)).toContain('Not sure which plan');                              // …and a way out
  await page.locator('.fl-opt').first().click();
  expect(await page.evaluate(() => [getPlanById(window.state.baseline).supplier, window.state.baseline_known])).toEqual(['Energia', true]);
});

test('"Include solar" with no system asks first instead of inventing one', async ({ page }) => {
  await boot(page, { current_screen: 'result', has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  await page.evaluate(() => window.toggleSolarModel());
  await expect(page.locator('.sg-h')).toContainText('Which way does your roof face');
  await page.locator('.sg-back').click();
  await expect.poll(() => screen(page)).toBe('result');
  expect(await page.evaluate(() => window.state.has_solar)).toBe(false);
});

test('solar explored in the guide is "planned", and the card only moves on its link', async ({ page }) => {
  await boot(page, { current_screen: 'result', has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  await page.getByRole('button', { name: /Thinking about solar/ }).click();
  await page.locator('.sg-tile', { hasText: 'South' }).first().click();
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.locator('.sg-own input').fill('7.5'); await page.locator('.sg-own input').blur();   // own battery size
  await page.getByRole('button', { name: /^Next/ }).click();
  await page.locator('.sg-grant').click();                                                     // grant off
  expect(await page.evaluate(() => [window.state.battery_kwh, window.state.grant_seai])).toEqual([7.5, 0]);
  await page.getByRole('button', { name: /Show me the answer/ }).click();
  await expect(page.locator('.sg-found')).toContainText('With panels, your best plan is');
  await page.getByRole('button', { name: /Add to my Home/ }).click();
  // Planned solar joins the one staircase on Home; nothing calls it installed.
  await expect(page.locator('.v7-hero')).toContainText('planned panels');
  await expect(page.locator('.v7-hero')).not.toContainText(/installed/i);
  await page.locator('.v7-hero .v7-solar-ctl small').click();
  expect(await screen(page)).toBe('result');                                                   // information goes nowhere
});

test('Analytics is five questions, a tab each, under the one lit Analytics tab', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'analytics', _an_tab: 'bill', has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 5 });
  // No car, no Car tab.
  await expect(page.locator('.ax-tab')).toHaveText(['Bill', 'Hours', 'Solar', 'Accuracy']);
  await expect(page.locator('h1.ax-h')).toHaveText('Where does your money go?');
  await expect(page.locator('h1')).toHaveCount(1);
  for (const [tab, q] of [['Hours', /When do you use it/], ['Solar', /Would the panels pay off/], ['Accuracy', /How sure are these figures/]]) {
    await page.locator('.ax-tab', { hasText: tab }).click();
    await expect(page.locator('h1.ax-h')).toHaveText(q);
    await expect(page.locator('.ax-tab.on')).toHaveText(tab);
    await expect(page.locator('.v7-nav-item.active')).toContainText('Analytics');
  }
  // The lit Analytics tab only scrolls; it never moves you off the question.
  await page.locator('.v7-nav-item.active').click();
  expect(await screen(page)).toBe('analytics');
  // From another surface it returns to the last question asked.
  await page.evaluate(() => window.setScreen('plans'));
  await page.locator('.v7-nav-item', { hasText: 'Analytics' }).click();
  await expect(page.locator('h1.ax-h')).toHaveText(/How sure are these figures/);
  expect(errors).toEqual([]);
});

test('without solar, the Solar tab is an invitation and nothing is modelled', async ({ page }) => {
  await boot(page, { current_screen: 'solar', has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  await expect(page.locator('h1.ax-h')).toHaveText('Would solar pay off here?');
  await expect(page.getByRole('button', { name: /Estimate it for my roof/ })).toBeVisible();
  expect(await page.evaluate(() => window.state.has_solar)).toBe(false);
});

test('a door on Home opens its question and says where it came from', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.locator('.ax-door', { hasText: 'Hours' }).click();
  await expect(page.locator('h1.ax-h')).toHaveText(/When do you use it/);
  await page.locator('.v7-home-back').click();
  expect(await screen(page)).toBe('result');
});

test('"not sure which plan" assumes a standard plan, never an EV or dynamic one', async ({ page }) => {
  await page.goto('/?fresh'); await page.waitForFunction(() => window.__bootSettled === true);
  await page.getByRole('button', { name: /Get started/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('.fl-sup', { hasText: 'Energia' }).click();
  await page.locator('.fl-opt', { hasText: 'Not sure which plan' }).click();
  expect(await page.evaluate(() => getPlanById(window.state.baseline).type)).not.toMatch(/ev|dynamic/);
});

test('planned solar never offers a switch to the plan you are already on', async ({ page }) => {
  await boot(page, { current_screen: 'result', has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 5 });
  const noSolarBest = await page.evaluate(() => { const v = document.querySelector('.v7-switch-btn'); return v && v.getAttribute('onclick'); });
  const planId = noSolarBest && noSolarBest.match(/'switch','([^']+)'/)[1];
  await page.evaluate((pid) => { window.state.baseline = pid; window.state.baseline_known = true; window.invalidate(); window.renderApp(); }, planId);
  await expect(page.locator('.v7-hero')).toContainText('already on the cheapest plan until the panels are in');
  const btns = await page.locator('.v7-switch-btn').evaluateAll((els) => els.map((e) => e.getAttribute('onclick')));
  expect(btns.some((b) => b.includes(`'${planId}'`))).toBe(false);
});

test('"not sure which plan" is kept as a guess, not as a known plan', async ({ page }) => {
  await page.goto('/?fresh'); await page.waitForFunction(() => window.__bootSettled === true);
  await page.getByRole('button', { name: /Get started/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('.fl-sup', { hasText: 'Energia' }).click();
  await page.locator('.fl-opt', { hasText: 'Not sure which plan' }).click();
  expect(await page.evaluate(() => window.state.baseline_known)).toBe(false);
  await expect(page.locator('.fl-chip').nth(1)).toContainText('plan not sure');
});

test('video fixes: one panels figure, and left-out solar is offered back', async ({ page }) => {
  await boot(page, { current_screen: 'result', has_solar: true, considering_solar: true, solar_planned: false, count_A: 10, battery_kwh: 9, _an_plan: 'BG-24' });
  // Home's solar card and the Solar tab say the same "a year from your panels".
  const engine = await page.evaluate(() => Math.round(window.v7SolarData().cur.solarBenefit));
  const card = await page.locator('section.hc', { hasText: 'Your solar panels' }).locator('.hc-fig').textContent();
  expect(card.replace(/[^\d]/g, '')).toContain(String(engine));
  await page.locator('section.hc', { hasText: 'Your solar panels' }).getByRole('button', { name: /Solar analysis/ }).click();
  const tab = await page.locator('.ax-eq-p b.is-gain').textContent();
  expect(tab.replace(/,/g, '')).toBe(`€${engine}`);
  await page.evaluate(() => { window.toggleSolarModel(); window.anTab('solar'); });
  await expect(page.locator('.ax-ans')).toContainText('Solar is switched off');
  await page.getByRole('button', { name: /Switch solar back on/ }).click();
  await expect(page.locator('.ax-ans .ax-big')).toContainText(/\d/);
});

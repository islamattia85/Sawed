// @ts-check
import { test, expect } from '@playwright/test';
import { isolate, boot } from './support.js';

// What a round of user testing found, each held to the fix.

async function fresh(page, width = 390) {
  await isolate(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
}
const heading = (page) => page.locator('.fl-q h2');
const pick = async (page, name) => { await page.getByRole('button', { name }).first().click(); await page.waitForTimeout(450); };

test('Back in setup goes back one question with the answer still picked; Forward and the arrow step too', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: 'planning solar' }).click();
  await pick(page, /East \/ Dublin/);
  await pick(page, /^Semi-detached/);
  await pick(page, /^South$/);
  await expect(heading(page)).toHaveText('How steep is the roof?');
  await page.goBack();
  await expect(heading(page)).toHaveText('Which way does the roof face?');
  await expect(page.locator('.fl-opt.on')).toContainText('South');
  await page.goBack();
  await expect(heading(page)).toHaveText('What kind of house is it?');
  await page.goForward();
  await expect(heading(page)).toHaveText('Which way does the roof face?');
  await page.locator('.fl-top .sg-back').click();
  await expect(heading(page)).toHaveText('What kind of house is it?');
  // Answering it again carries on to the first question still open.
  await pick(page, /^Semi-detached/);
  await expect(heading(page)).toHaveText('How steep is the roof?');
});

test('Back from the first question leaves setup; Forward comes back in; the same way in carries on', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: 'planning solar' }).click();
  await expect(heading(page)).toHaveText('Where in Ireland is the home?');
  await page.goBack();
  await expect(page.locator('.wl-site')).toBeVisible();
  await page.goForward();
  await expect(heading(page)).toHaveText('Where in Ireland is the home?');
  await pick(page, /East \/ Dublin/);
  await pick(page, /^Semi-detached/);
  await page.locator('.fl-exit').click();
  await expect(page.locator('.wl-site')).toBeVisible();
  await page.getByRole('button', { name: 'planning solar' }).click();
  await expect(heading(page)).toHaveText('Which way does the roof face?');
  await expect(page.locator('.fl-step-k')).toContainText('Step 3 of');
});

test('the step total never grows as the answers come in', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => window.siteGo('solar'));
  const totals = [];
  const read = async () => { const t = await page.locator('.fl-step-k').textContent(); totals.push(+String(t).match(/of (\d+)/)[1]); };
  await read();
  for (const [q, v] of [['where', 'east'], ['house', 'semi'], ['roof', 'S'], ['tilt', 35], ['bill', 250], ['meter', 'smart'], ['area', 'urban'],
    ['plan', 'EI-24'], ['disc', 0], ['heat', 'gas'], ['gas', 'no'], ['night', 'no'], ['system', 'custom'], ['panels', 12], ['battery', 5], ['price', 0], ['grant', 'yes']]) {
    await page.evaluate(([q, v]) => window.flowAnswer(q, v), [q, v]);
    if (await page.locator('.fl-step-k').count()) await read();
  }
  for (let i = 1; i < totals.length; i++) expect(totals[i], `totals ${totals.join(' → ')}`).toBeLessThanOrEqual(totals[i - 1]);
});

test('a plan with its discount in the name: the question says so, and the same figure is not counted twice', async ({ page }) => {
  await fresh(page, 1280);
  await page.evaluate(() => { window.siteGo('plans'); window.flowAnswer('bill', 400); window.flowAnswer('meter', 'nightsaver'); window.flowAnswer('area', 'urban'); window.flowAnswer('plan', 'SSE-NS'); });
  await expect(heading(page)).toHaveText('Any discount on top of the 30%?');
  await page.fill('#flow-own-disc', '30');
  await page.locator('#flow-own-disc').press('Enter');
  expect(await page.evaluate(() => window.state.baseline_discount_pct)).toBe(0);
  await page.evaluate(() => { window.flowAnswer('heat', 'storage'); window.flowAnswer('heattime', 'night'); });
  // On these rates another plan is cheaper for this home: the double count used to hide it.
  await expect(page.locator('.fl-reveal')).not.toContainText('already on a good plan');
});

test('saved homes with a plan’s own discount typed again are put right', async ({ page }) => {
  await boot(page, { baseline: 'SSE-NS', baseline_known: true, baseline_discount_pct: 30, meter_type: 'nightsaver', heating_type: 'storage' });
  expect(await page.evaluate(() => window.state.baseline_discount_pct)).toBe(0);
});

test('a withdrawn plan can be picked in setup, marked as no longer on sale', async ({ page }) => {
  await fresh(page, 1280);
  await page.evaluate(() => { window.siteGo('plans'); window.flowAnswer('bill', 300); window.flowAnswer('meter', 'smart'); window.flowAnswer('area', 'urban'); });
  await page.getByRole('button', { name: /Pinergy/ }).first().click();
  const gone = page.getByRole('button', { name: /Lifestyle EV Night Time/ });
  await expect(gone).toContainText('No longer on sale since 21 May 2026');
  await gone.click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => [window.state.baseline, window.state.baseline_known])).toEqual(['PIN-EV', true]);
});

test('for planned panels, Updates gives the same switch-now plan and figure as Home', async ({ page }) => {
  await boot(page, { solar_planned: true, has_solar: true, count_A: 12, battery_kwh: 0, baseline: 'BG-24', baseline_known: true, bimonthly_bill_eur: 320 }, '/');
  const home = await page.evaluate(() => {
    window.setScreen('result');
    const t = document.querySelector('.screen').innerText;
    const m = t.match(/€([\d,]+) from switching plan, today/);
    return m ? +m[1].replace(/,/g, '') : null;
  });
  const alert = await page.evaluate(() => (window.computeAlerts().find((a) => a.kind === 'cheaper') || {}).title || '');
  const m = alert.match(/would save you €([\d,]+) a year/);
  expect(home, 'Home shows a switch-now saving').not.toBeNull();
  expect(m, `Updates: "${alert}"`).not.toBeNull();
  expect(+m[1].replace(/,/g, '')).toBe(home);
});

test('owners are asked about their panels as bought, and a yearly kWh figure is not asked for its months', async ({ page }) => {
  await fresh(page, 1280);
  await page.evaluate(() => window.siteGo('have'));
  await page.evaluate(() => { for (const [q, v] of [['where', 'west'], ['roof', 'EW'], ['tilt', 35], ['panels', 14], ['battery', 10], ['gridnow', 'yes']]) window.flowAnswer(q, v); });
  await expect(heading(page)).toHaveText('What did the panels cost?');
  await page.evaluate(() => window.flowAnswer('price', 0));
  await expect(heading(page)).toHaveText('Did you get the SEAI grant for them?');
  await page.evaluate(() => { for (const [q, v] of [['grant', 'yes'], ['bill', 'kwh:7000'], ['meter', 'smart'], ['area', 'rural'], ['plan', 'unsure'], ['heat', 'gas'], ['night', 'no']]) window.flowAnswer(q, v); });
  await expect(heading(page)).toHaveText('Is that usage from before or after the panels went up?');
  await page.evaluate(() => window.flowAnswer('billwhen', 'after'));
  await expect(heading(page)).not.toHaveText('Which months is that bill for?');
  // Units bought after the panels are less than the home uses: the model works back to more.
  const used = await page.evaluate(() => Object.values(window.state.bills).reduce((a, b) => a + b, 0));
  expect(used).toBeGreaterThan(7000);
});

test('on a phone the question clears the sticky bar after an answer, and Enter moves on', async ({ page }) => {
  await fresh(page);
  await page.getByRole('button', { name: 'I just want a cheaper plan' }).click();
  await page.fill('#flow-bill', '260');
  await page.locator('#flow-bill').press('Enter');
  await expect(heading(page)).toHaveText('Which electricity meter do you have?');
  const pos = await page.evaluate(() => ({ label: document.querySelector('.fl-step-k').getBoundingClientRect().top, bar: document.querySelector('.fl-top').getBoundingClientRect().bottom }));
  expect(pos.label).toBeGreaterThanOrEqual(pos.bar);
});

test('the quote check starts from the quote given in setup and explains today’s benchmark', async ({ page }) => {
  await boot(page, { cost_is_manual: true, install_cost: 11500, count_A: 12, battery_kwh: 5 });
  await page.evaluate(() => window.setScreen('auditor'));
  expect(await page.evaluate(() => ['aud-price', 'aud-panels', 'aud-battery'].map((id) => document.getElementById(id).value))).toEqual(['11500', '12', '5']);
  await expect(page.locator('.screen')).toContainText('How we judge the price');
  await expect(page.locator('.screen')).not.toContainText('€950');
  await page.locator('#aud-price').press('Enter');
  await expect(page.locator('#audit-result')).toContainText(/A fair price|On the high side|Cheaper than most|Well above/);
});

test('coming back to the website address opens the front page; a page in the address keeps its place', async ({ page }) => {
  await boot(page, { current_screen: 'solar' }, '/');
  await expect(page.locator('.wl-site')).toBeVisible();
  await expect(page.locator('.wl-bar .wl-btn-p')).toHaveText('My answer');
  await page.goto('/#plans');
  await page.reload();
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.state.current_screen)).toBe('plans');
  // The app never opens on its start page for a home that is set up, even
  // straight after the website's front page.
  await page.goto('/');
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
  await expect(page.locator('.wl-site')).toBeVisible();
  await page.evaluate(() => window.saveState());
  await page.goto('/app');
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
  expect(await page.evaluate(() => window.state.current_screen)).toBe('result');
});

test('a plan card says what each figure is, with no minus signs', async ({ page }) => {
  await boot(page, { current_screen: 'plans', has_solar: true, considering_solar: true, count_A: 16, battery_kwh: 10, baseline: 'BG-24', _plans_all: true });
  const cards = page.locator('.v7-plan');
  await expect(cards.first()).toBeVisible();
  const texts = await page.locator('.v7-plan-cost').allInnerTexts();
  for (const t of texts) {
    expect(t, t).not.toMatch(/[-−]\s?€/);
    expect(t, t).toMatch(/a year/);
    expect(t, t).toMatch(/(less|more) than now|same as now|what you pay now/);
  }
});

test('Bord Gáis is one supplier, not two', async ({ page }) => {
  await fresh(page, 1280);
  await page.evaluate(() => { window.siteGo('plans'); window.flowAnswer('bill', 300); window.flowAnswer('meter', 'smart'); window.flowAnswer('area', 'urban'); });
  const names = await page.locator('.fl-sup').allInnerTexts();
  expect(names.filter((n) => /Bord G/.test(n))).toHaveLength(1);
  expect(await page.evaluate(() => [...new Set(window.TARIFFS.filter((p) => /Bord G/.test(p.supplier)).map((p) => p.supplier))])).toEqual(['Bord Gáis Energy']);
});

test('Updates names the score and says what it is out of', async ({ page }) => {
  await boot(page, { current_screen: 'updates' });
  const sum = page.locator('.up-progress > summary');
  await expect(sum).toContainText('of 100');
  await expect(sum).toContainText('Savings score');
  await expect(sum).not.toContainText('points');
  await sum.click();
  await expect(page.locator('.up-progress')).toContainText('out of 100');
});

test('on Updates the bell has no count; elsewhere it shows what is new', async ({ page }) => {
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  await page.setViewportSize({ width: 1440, height: 900 });
  await boot(page, { contract_end: soon, alerts_seen: {} }, '/#result');
  await expect(page.locator('.web-bell .web-badge')).toBeVisible();
  await page.evaluate(() => window.setScreen('updates'));
  await expect(page.locator('.web-bell .web-badge')).toHaveCount(0);
  await expect(page.locator('.web-links .web-badge')).toHaveCount(0);
});

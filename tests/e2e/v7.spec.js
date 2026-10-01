import { test, expect } from '@playwright/test';
import { boot, bootFresh } from './support.js';

/**
 * V7's own promises.
 *
 * The redesign replaced a single "you could save" figure with a ladder, lists
 * with bars, and screens with sheets. Each of those is only an improvement if
 * it is faithful — a ladder whose rungs do not add up, or a bar whose length
 * is not the cost, is a prettier way of being wrong. These tests hold that.
 */

test('the ladder adds up: switching plus solar is the whole saving', async ({ page }) => {
  const errors = await boot(page);
  const r = await page.evaluate(() => {
    const rungs = [...document.querySelectorAll('.v7-ladder [data-rung]')]
      .map((g) => ({ label: g.dataset.label, value: +g.dataset.value }));
    const rec = window.getRecommendation();
    return { rungs, base: rec.baseCost, net: rec.best.net, saving: rec.annualSavings };
  });

  expect(r.rungs.length, 'solar home shows: without solar, with solar, then switched').toBe(3);
  expect(Math.abs(r.rungs[0].value - r.base)).toBeLessThan(1);
  expect(Math.abs(r.rungs[2].value - r.net)).toBeLessThan(1);
  // The two parts of the saving are read off the rungs and must sum to the
  // headline. Solar is the first step; switching is measured on the home with
  // its solar, because that is the home the switch happens to.
  const fromSolar = r.rungs[0].value - r.rungs[1].value;
  const fromSwitch = r.rungs[1].value - r.rungs[2].value;
  expect(Math.abs(fromSwitch + fromSolar - r.saving), 'the parts do not sum to the headline').toBeLessThan(2);
  expect(fromSwitch, 'switching alone cannot cost money if it is the recommendation').toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('the switch button says what the switch is worth, not what the panels earn', async ({ page }) => {
  await boot(page);
  const { cta, rungs } = await page.evaluate(() => ({
    cta: document.querySelector('.switch-cta').textContent.replace(/\s+/g, ' '),
    rungs: [...document.querySelectorAll('.v7-ladder [data-rung]')].map((g) => +g.dataset.value),
  }));
  const fromSwitch = Math.round(rungs[1] - rungs[2]);
  expect(cta).toContain(`€${fromSwitch.toLocaleString('en-IE')}/yr`);
});

test('the plans list and the home agree on what switching is worth', async ({ page }) => {
  // The row for the recommended plan and the switch step on the home ladder are
  // the same question — what does changing plan save this home — and must give
  // the same answer. They disagreed by over a thousand euro when the rows were
  // measured against a bill without the solar.
  await boot(page);
  const step = await page.evaluate(() => {
    const v = [...document.querySelectorAll('.v7-ladder [data-rung]')].map((g) => +g.dataset.value);
    return Math.round(v[1] - v[2]);
  });
  await page.evaluate(() => window.setScreen('plans'));
  const row = await page.evaluate(() => {
    const el = document.querySelector('.v7-plan.best .v7-plan-delta');
    return Math.round(parseFloat(el.textContent.replace(/[^\d.]/g, '')));
  });
  expect(Math.abs(row - step), `row says €${row}, home says €${step}`).toBeLessThanOrEqual(1);
});

test('a home without solar gets a two-rung ladder, with nothing credited to panels', async ({ page }) => {
  await boot(page, { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  const n = await page.locator('.v7-ladder [data-rung]').count();
  expect(n).toBe(2);
  await expect(page.locator('.v7-split')).toHaveCount(0);
});

test('every plan bar is its cost on the same ruler', async ({ page }) => {
  await boot(page, { current_screen: 'plans', _plans_all: true });
  const rows = await page.evaluate(() => [...document.querySelectorAll('.v7-plan')].map((el) => ({
    width: parseFloat(el.querySelector('.v7-bar > span').style.width),
    cost: parseFloat(el.querySelector('.plan-cost').textContent.replace(/[^\d.-]/g, '')),
  })));
  expect(rows.length).toBeGreaterThan(10);
  // Width / cost is the same constant for every plan above the minimum sliver.
  const k = rows.filter((r) => r.width > 3).map((r) => r.width / r.cost);
  const spread = Math.max(...k) / Math.min(...k);
  expect(spread, 'bars are not drawn on one scale').toBeLessThan(1.02);
});

test('a plan opens as a sheet over the list, and closes back onto it', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'plans' });
  await page.locator('.v7-plan').nth(1).click();
  await expect(page.locator('#v7-sheet')).toBeVisible();
  // No navigation happened — the list is still underneath.
  expect(await page.evaluate(() => window.state.current_screen)).toBe('plans');
  await expect(page.locator('#v7-sheet .v7-ratestrip')).toBeVisible();

  await page.locator('.v7-sheet-x').click();
  await expect(page.locator('#v7-sheet')).toHaveCount(0);
  expect(await page.evaluate(() => window.state.current_screen)).toBe('plans');
  expect(errors).toEqual([]);
});

test('a plan with an announced rise says so on its row and in its sheet', async ({ page }) => {
  await boot(page, { current_screen: 'plans', _plans_all: true });
  const id = await page.evaluate(() => (window.TARIFFS || []).find((t) => t.price_change && !t.discontinued)?.id);
  test.skip(!id, 'no announced price changes in the current data');
  await page.evaluate((pid) => window.v7Sheet('plan', pid), id);
  await expect(page.locator('#v7-sheet .v7-note.is-rise')).toContainText(/Prices rise/);
});

test('no screen shouts: nothing is set in uppercase by style', async ({ page }) => {
  await boot(page);
  const shouting = await page.evaluate(() => {
    const out = [];
    for (const s of ['result', 'plans', 'solar', 'more', 'analytics', 'monitor']) {
      window.setScreen(s);
      for (const el of document.querySelectorAll('#app-root *')) {
        if (getComputedStyle(el).textTransform === 'uppercase' && el.textContent.trim()) {
          out.push(`${s}: ${el.textContent.trim().slice(0, 30)}`);
        }
      }
    }
    return out;
  });
  expect(shouting).toEqual([]);
});

test('the four tabs are destinations: no back arrow on any of them', async ({ page }) => {
  await boot(page);
  for (const s of ['result', 'plans', 'solar', 'more']) {
    await page.evaluate((x) => window.setScreen(x), s);
    await expect(page.locator('.v7-top [aria-label="Back"]'), `${s} shows a back arrow`).toHaveCount(0);
  }
});

test('the way back into setup, and sharing, survive the redesign', async ({ page }) => {
  // V7's first cut dropped both from the home screen and nothing noticed — a
  // returning visitor then had no route back into the guided setup at all.
  const errors = await boot(page);
  await expect(page.getByRole('button', { name: /Share analysis/ })).toBeVisible();
  await page.getByRole('button', { name: /Re-run setup/ }).click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('onboarding');
  expect(errors).toEqual([]);
});

test('solar can be left out in one tap, and comes back as the same system', async ({ page }) => {
  const errors = await boot(page, { count_A: 14, battery_kwh: 10 });
  const rungs = () => page.locator('.v7-ladder [data-rung]').count();
  const saving = () => page.evaluate(() => window.getRecommendation().annualSavings);

  expect(await rungs()).toBe(3);
  const withSolar = await saving();

  await page.getByRole('switch', { name: /Include solar/ }).click();
  await expect.poll(rungs).toBe(2);
  expect(await page.evaluate(() => window.state.has_solar)).toBe(false);
  expect(await saving(), 'leaving solar out did not change the figures').toBeLessThan(withSolar);
  // The system is kept, not wiped.
  expect(await page.evaluate(() => [window.state.count_A, window.state.battery_kwh])).toEqual([14, 10]);

  await page.getByRole('switch', { name: /Include solar/ }).click();
  await expect.poll(rungs).toBe(3);
  expect(Math.round(await saving())).toBe(Math.round(withSolar));
  expect(errors).toEqual([]);
});

test('the same switch is at the top of the Solar screen', async ({ page }) => {
  await boot(page, { current_screen: 'solar' });
  await page.getByRole('switch', { name: /Include solar/ }).click();
  await expect(page.locator('.v7-solar-hero')).toContainText(/left out of every figure/);
  await page.getByRole('switch', { name: /Include solar/ }).click();
  await expect(page.locator('.v7-solar-hero .qr-value')).toContainText(/yr payback/);
});

test('opening Solar with no solar models nothing', async ({ page }) => {
  // It used to build an estimated array the moment the tab opened, so a home
  // that had said "no solar" found panels switched on — and every figure on
  // Home changed — just for looking.
  const errors = await boot(page, { has_solar: false, considering_solar: false, battery_kwh: 0 });
  const before = await page.evaluate(() => window.getRecommendation().annualSavings);

  await page.getByRole('button', { name: /^Solar$/ }).click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('solar');
  expect(await page.evaluate(() => [window.state.has_solar, !!window.state.considering_solar]))
    .toEqual([false, false]);
  await expect(page.locator('.v7-solar-hero')).toContainText(/No solar is modelled/);
  await expect(page.getByRole('switch', { name: /Include solar/ })).toContainText(/Not modelled/);

  await page.evaluate(() => window.setScreen('result'));
  expect(await page.evaluate(() => window.getRecommendation().annualSavings)).toBe(before);
  expect(errors).toEqual([]);
});

test('a home without panels sees only solar on the Solar tab', async ({ page }) => {
  // It used to show the health score, the market, the hourly view and "best
  // plan WITH this solar" to a home that had no solar at all.
  await boot(page, { has_solar: false, considering_solar: false, battery_kwh: 0, current_screen: 'solar' });
  const text = await page.evaluate(() => document.querySelector('.screen').innerText);
  expect(text).not.toMatch(/health score|Hour by hour|Market|WITH this solar/i);
  await expect(page.getByRole('button', { name: /Model a system for this roof/ })).toBeVisible();
});

test('the health sheet carries its own advice', async ({ page }) => {
  await boot(page, { current_screen: 'result' });
  await page.locator('.v7-tile-score').click();
  await expect(page.locator('#v7-sheet .v7-ring')).toBeVisible();
  await expect(page.locator('#v7-sheet')).toContainText(/Weakest:|Little left on the table/);
});

test('Market and Hour by hour are reachable from More', async ({ page }) => {
  await boot(page, { current_screen: 'more' });
  await expect(page.getByText('Market', { exact: true })).toBeVisible();
  await expect(page.getByText('Hour by hour', { exact: true })).toBeVisible();
});

test('the health score judges the plan on the same home the ladder does', async ({ page }) => {
  // It compared the bill WITHOUT solar with the best plan WITH it, scoring a
  // solar home 23 for plan efficiency when switching was worth €148 of €551.
  await boot(page);
  const mine = await page.evaluate(() =>
    Math.round(+document.querySelectorAll('.v7-ladder [data-rung]')[1].dataset.value));
  await page.locator('.v7-tile-score').click();
  const weak = await page.locator('#v7-sheet').innerText();
  const m = weak.match(/You pay €([\d,]+)/);
  if (m) expect(+m[1].replace(/,/g, '')).toBe(mine);
  const plan = await page.evaluate(() => [...document.querySelectorAll('#v7-sheet .v7-part')]
    .map((el) => el.innerText.split('\n')).find((p) => /Plan efficiency/.test(p[0])));
  expect(plan, 'no plan-efficiency factor').toBeTruthy();
  expect(+plan[plan.length - 1]).toBeGreaterThan(50);
});

test('the month chart opens a swipeable month-by-month sheet', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'solar' });
  // Tap July's bars: the sheet opens on July, not January.
  await page.locator('.v7-months-card [data-month="6"] rect').first().click();
  await expect(page.locator('#v7-sheet .v7-month')).toHaveCount(12);
  await expect.poll(() => page.evaluate(() => window.state._sheet.id)).toBe('6');
  await expect(page.locator('.v7-month-dot.active')).toHaveText('J');

  // Swipe to the next month.
  await page.evaluate(() => {
    const t = document.querySelector('.v7-months-track');
    t.scrollLeft = t.children[7].offsetLeft - t.offsetLeft;
    t.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.evaluate(() => window.state._sheet.id)).toBe('7');

  // The twelve cards add up to the year the chart shows.
  const sums = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.v7-month')];
    const kwh = (t) => +t.replace(/[^\d]/g, '');
    const solar = cards.reduce((a, c) => a + kwh(c.querySelectorAll('.v7-month-bar b')[0].textContent), 0);
    const legend = document.querySelector('.v7-months-card .v7-legend').textContent;
    return { solar, year: kwh(legend.match(/solar ([\d,]+)/)[1]) };
  });
  expect(Math.abs(sums.solar - sums.year), 'months do not add up to the year').toBeLessThanOrEqual(12);
  expect(errors).toEqual([]);
});


test('the EV lives on Home, not on the Solar tab', async ({ page }) => {
  const errors = await boot(page, { ev_active: true, current_screen: 'solar', _solar_detail_open: true });
  await expect(page.getByText('EV petrol displacement')).toHaveCount(0);
  await boot(page, { ev_active: true, ev_km_per_year: 15000 });
  const tile = page.locator('.v7-tile-ev');
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('EV saves vs petrol');
  await tile.click();
  await expect(page.locator('#v7-sheet')).toContainText('a year less than petrol');
  await expect(page.locator('#v7-sheet')).toContainText('Cheapest plans to charge on');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'screenshots/24-ev-sheet.png' });
  expect(errors).toEqual([]);
});

test('no EV, no EV tile', async ({ page }) => {
  await boot(page, { ev_active: false });
  await expect(page.locator('.v7-tile-ev')).toHaveCount(0);
});

test('the landing page is reachable from More, and leads back', async ({ page }) => {
  await boot(page, { current_screen: 'more' });
  await page.getByText('Start page').click();
  await expect(page.locator('.pk-land')).toBeVisible();
  await page.getByText('Back to my results').click();
  expect(await page.evaluate(() => window.state.current_screen)).toBe('result');
});

test('modelling solar after a no-solar setup prices the system, even if a quote was once typed', async ({ page }) => {
  await boot(page, { has_solar: false, considering_solar: false, count_A: 0, count_B: 0, battery_kwh: 0,
    install_cost: 0, grant_seai: 0, cost_is_manual: true, current_screen: 'solar' });
  await page.getByRole('button', { name: /Model a system/ }).click();
  const st = await page.evaluate(() => ({ c: window.state.install_cost, n: window.state.count_A }));
  expect(st.n).toBeGreaterThan(0);
  expect(st.c).toBeGreaterThan(3000);
});

test('Automatic battery strategy is never worse than either fixed setting, plan by plan', async ({ page }) => {
  await boot(page, { strategy_mode: 'auto', charge_from_grid: true, battery_kwh: 10 });
  const r = await page.evaluate(() => {
    const ids = window.TARIFFS.filter((t) => !t.discontinued).map((t) => t.id);
    const cost = (mode, grid) => {
      window.state.strategy_mode = mode; window.state.charge_from_grid = grid; window.invalidate();
      return Object.fromEntries(ids.map((id) => [id, (() => { const p = window.TARIFFS.find((t) => t.id === id); return window.__annual(window.sim(id), p); })()]));
    };
    const auto = cost('auto', true), arb = cost('arbitrage', true), self = cost('self-consume', false);
    return ids.filter((id) => auto[id] > Math.min(arb[id], self[id]) + 0.5);
  });
  expect(r).toEqual([]);
});

test('when nothing beats the current plan, the answer is to stay — not €0 and a switch button', async ({ page }) => {
  await boot(page, { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0 });
  const cheapest = await page.evaluate(() => window.getRecommendation().cheapest.plan.id);
  await boot(page, { has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0, baseline: cheapest });
  const hero = page.locator('.v7-hero');
  await expect(hero).toContainText('already the best value');
  await expect(page.locator('.v7-switch-btn')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /See every plan compared/ })).toBeVisible();
  // Like for like: today's bill and the same plan's cost carry the same levy.
  const r = await page.evaluate(() => window.getRecommendation());
  expect(Math.abs(r.baseCost - r.cheapest.net)).toBeLessThan(1);
});

test('My system: sliders, battery stops, grant switch and fine-tune change the model', async ({ page }) => {
  await boot(page, { current_screen: 'solar' });
  await page.locator('.v7-system').click();
  const sheet = page.locator('#v7-sheet');
  await expect(sheet).toContainText('My system');
  await expect(sheet.locator('.sy-acc')).toContainText('±');

  // Panels: drag the slider, the model follows on release.
  await sheet.locator('#sy-total').fill('16');
  await sheet.locator('#sy-total').dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => window.state.count_A + window.state.count_B)).toBe(16);

  // Battery: a real product size in one tap, an odd one typed exactly.
  await sheet.getByRole('button', { name: '13.5', exact: true }).click();
  expect(await page.evaluate(() => window.state.battery_kwh)).toBe(13.5);
  await sheet.getByLabel('Exact battery size in kWh').fill('11.5');
  await sheet.getByLabel('Exact battery size in kWh').dispatchEvent('change');
  expect(await page.evaluate(() => window.state.battery_kwh)).toBe(11.5);

  // Grant off, then back on to the standard amount.
  const grant = sheet.locator('.sy-toggle input').first();
  await grant.uncheck();
  expect(await page.evaluate(() => window.state.grant_seai)).toBe(0);
  await grant.check();
  expect(await page.evaluate(() => window.state.grant_seai)).toBeGreaterThan(0);

  // Fine-tuning the panels marks them confirmed and tightens the estimate.
  await sheet.getByRole('button', { name: /Fine-tune panels/ }).click();
  const watts = sheet.locator('.sy-fine-body input').first();
  await watts.fill('445');
  await watts.dispatchEvent('change');
  expect(await page.evaluate(() => window.state.panel_w)).toBe(445);
  expect(await page.evaluate(() => window.modelAccuracy().parts.map((p) => p.label)))
    .toContain('Panel spec confirmed');
  await expect(sheet).toContainText('confirmed');
});

test('My home holds the house, the usage and the roof', async ({ page }) => {
  await boot(page);
  await page.locator('.v7-home-chips').click();
  const sheet = page.locator('#v7-sheet');
  await expect(sheet).toContainText('My home');
  await sheet.locator('select').nth(1).selectOption('heatpump');
  expect(await page.evaluate(() => window.state.heating_type)).toBe('heatpump');
  await expect(sheet.locator('.sy-part[aria-label=Roof]')).toContainText('assumed');
  await sheet.locator('.sy-part[aria-label=Roof] input').first().fill('40');
  await sheet.locator('.sy-part[aria-label=Roof] input').first().dispatchEvent('change');
  expect(await page.evaluate(() => window.state.tilt_A)).toBe(40);
  await expect(sheet.locator('.sy-part[aria-label=Roof]')).toContainText('confirmed');
});

test('a first visit opens on the start page, with the brand', async ({ page }) => {
  await bootFresh(page);
  await expect(page.locator('.pk-land')).toBeVisible();
  await expect(page.locator('.pk-land .pk-word')).toHaveAttribute('aria-label', 'Peakless');
});

test('Advanced keeps only what My home and My system do not hold', async ({ page }) => {
  await boot(page, { current_screen: 'refine', battery_kwh: 5, has_solar: true, considering_solar: true, count_A: 12 });
  const titles = await page.locator('.settings-section-title').allTextContents();
  const t = titles.join(' | ');
  expect(t).toMatch(/Battery strategy/);
  expect(t).toMatch(/consumption shape/i);
  expect(t).not.toMatch(/Home & bills|Solar system|Electric vehicle/);
  await expect(page.getByText('Simple', { exact: true })).toHaveCount(0);
  // The two sheets are one tap away, and open over a surface that can show them.
  await page.locator('.adv-link', { hasText: 'My system' }).click();
  await expect(page.locator('#v7-sheet')).toContainText('My system');
});

test('My home carries the EV details and the plan discount', async ({ page }) => {
  await boot(page, { ev_active: true, ev_km_per_year: 12000 });
  await page.evaluate(() => window.openMyHome());
  const ev = page.locator('#v7-sheet .sy-part[aria-label="Electric car"]');
  const km = ev.locator('input[type=number]').first();
  await km.fill('20000');
  await km.dispatchEvent('change');
  expect(await page.evaluate(() => window.state.ev_km_per_year)).toBe(20000);
  await expect(page.locator('#v7-sheet')).toContainText('Discount on it');
});

test('sheet fields never trigger the iOS focus zoom, and sheets never scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await boot(page, { ev_active: true, battery_kwh: 5, has_solar: true, considering_solar: true, count_A: 12 });
  for (const open of ['openMyHome()', "openMySystem();sysFine('panels',true);sysFine('battery',true)"]) {
    await page.evaluate(open);
    const r = await page.evaluate(() => {
      const sh = document.querySelector('.v7-sheet');
      const coarse = matchMedia('(pointer: coarse)').matches;
      const small = [...sh.querySelectorAll('input[type=number], select')]
        .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length;
      return { coarse, small, over: sh.scrollWidth - sh.clientWidth, ox: getComputedStyle(sh).overflowX };
    });
    if (r.coarse) expect(r.small, 'fields under 16px zoom the page on iPhone').toBe(0);
    expect(r.over).toBeLessThanOrEqual(0);
    expect(r.ox).toBe('hidden');
  }
});

test('My Peakless: a guest sees the household, the quotes and why an account helps', async ({ page }) => {
  await boot(page, { current_screen: 'more', has_solar: true, considering_solar: true, count_A: 12, battery_kwh: 5,
    solar_quotes: [{ id: 'q1', installer: 'Sunny Ltd', price: 9800, kwp: 6.6, battery: 10, source: 'upload' }] });
  await page.locator('.me-entry').click();
  expect(await page.evaluate(() => window.state.current_screen)).toBe('me');
  const me = page.locator('.screen.me');
  await expect(me.locator('.me-guest')).toContainText('saved on this phone only');
  await expect(me.locator('.me-card')).toHaveCount(3);
  await expect(me).toContainText('Sunny Ltd');
  // The More tab stays lit: My Peakless lives under it.
  await expect(page.locator('.v7-nav-item.active')).toContainText('More');

  // A saved quote becomes the modelled system in one tap.
  await me.getByRole('button', { name: 'Model it' }).click();
  expect(await page.evaluate(() => window.state.current_screen)).toBe('solar');
  const s = await page.evaluate(() => ({ b: window.state.battery_kwh, c: window.state.install_cost, manual: window.state.cost_is_manual }));
  expect(s).toEqual({ b: 10, c: 9800, manual: true });

  // The household cards open the sheets.
  await page.evaluate(() => window.setScreen('me'));
  await page.locator('.me-card', { hasText: 'My home' }).click();
  await expect(page.locator('#v7-sheet')).toContainText('My home');
});

test('account sync: screen state stays local, quotes are never lost, the same home is recognised', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const { cloudCopy, setupKey, mergeQuotes } = window.__sync;
    const copy = cloudCopy({ ...window.state, _sheet: { kind: 'home' }, current_screen: 'plans' });
    const a = { ...window.state };
    const b = { ...window.state, current_screen: 'solar', theme: 'dark' };
    const c = { ...window.state, battery_kwh: (window.state.battery_kwh || 0) + 5 };
    return {
      leaks: ['_sheet', 'current_screen', '_saved_at', '_account_id'].filter((k) => k in copy),
      keepsHome: copy.region === window.state.region && copy.baseline === window.state.baseline,
      sameHome: setupKey(a) === setupKey(b),
      otherHome: setupKey(a) === setupKey(c),
      quotes: mergeQuotes([{ id: '1' }, { id: '2' }], [{ id: '2' }, { id: '3' }]).map((q) => q.id),
    };
  });
  expect(r.leaks).toEqual([]);
  expect(r.keepsHome).toBe(true);
  expect(r.sameHome).toBe(true);
  expect(r.otherHome).toBe(false);
  expect(r.quotes).toEqual(['1', '2', '3']);
});

test('a quote is saved without touching the system; modelling it keeps the old system to bring back', async ({ page }) => {
  await boot(page, { current_screen: 'solar', has_solar: true, considering_solar: true, count_A: 14, battery_kwh: 10,
    install_cost: 13000, cost_is_manual: true, solar_planned: false, solar_quotes: [] });
  const read = { is_solar_quote: true, installer: 'Bright Roofs', panel_count: 10, panel_watts: 440, battery_kwh: 5,
    price_total_eur: 9000, grant_eur: 1800, warnings: [], extras: [], evidence: {} };
  await page.evaluate((q) => { window.__setQuoteRead({ status: 'review', quote: q }); window.v7Sheet('quote'); }, read);
  await page.getByRole('button', { name: /Save to my quotes/ }).click();
  let st = await page.evaluate(() => ({ n: window.state.count_A, b: window.state.battery_kwh, q: window.state.solar_quotes.length }));
  expect(st).toEqual({ n: 14, b: 10, q: 1 });

  await page.evaluate((q) => { window.__setQuoteRead({ status: 'review', quote: q }); window.v7Sheet('quote'); }, read);
  await page.getByRole('button', { name: /Model my home with this quote/ }).click();
  st = await page.evaluate(() => ({ n: window.state.count_A, b: window.state.battery_kwh, planned: window.state.solar_planned,
    prev: window.state.solar_quotes.find((x) => x.source === 'previous')?.installer }));
  expect(st).toEqual({ n: 10, b: 5, planned: true, prev: 'Your installed system' });

  // One tap brings the installed system back, exactly.
  await page.evaluate(() => window.setScreen('me'));
  await page.getByRole('button', { name: 'Bring back' }).click();
  st = await page.evaluate(() => ({ n: window.state.count_A, b: window.state.battery_kwh, c: window.state.install_cost, planned: window.state.solar_planned }));
  expect(st).toEqual({ n: 14, b: 10, c: 13000, planned: false });
});

test('closing My home or My system goes back to the screen it was opened from', async ({ page }) => {
  await boot(page, { current_screen: 'me', has_solar: true, considering_solar: true, count_A: 12 });
  for (const open of ['openMyHome()', 'openMySystem()']) {
    await page.evaluate(open);
    await expect(page.locator('#v7-sheet')).toBeVisible();
    await page.locator('.v7-sheet-x').click();
    expect(await page.evaluate(() => window.state.current_screen)).toBe('me');
  }
  // The household picture opens them too.
  await expect(page.locator('.hs')).toBeVisible();
  await page.locator('.hs-hit[aria-label="My home"]').click({ force: true });
  await expect(page.locator('#v7-sheet')).toContainText('My home');
});

test('alerts: a contract ending shows in My Peakless with a badge that clears once seen', async ({ page }) => {
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  await boot(page, { contract_end: soon, alerts_seen: {} });
  const kinds = await page.evaluate(() => window.computeAlerts().map((a) => a.kind));
  expect(kinds).toContain('contract');
  await expect(page.locator('.nav-badge')).toBeVisible();
  await page.evaluate(() => window.setScreen('me'));
  await expect(page.locator('.al-list')).toContainText('Your contract ends in');
  await expect.poll(() => page.evaluate(() => Object.keys(window.state.alerts_seen || {}).length), { timeout: 5000 })
    .toBeGreaterThan(0);
  await page.evaluate(() => window.setScreen('result'));
  await expect(page.locator('.nav-badge')).toHaveCount(0);
});

test('the tally: recording a switch makes it the plan, sets the contract, and counts the saving from the date', async ({ page }) => {
  await boot(page, { current_screen: 'me', journey: [] });
  await page.getByRole('button', { name: /I switched plan/ }).click();
  const sheet = page.locator('#v7-sheet');
  const to = await sheet.locator('#jr-plan').inputValue();
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  await sheet.locator('#jr-date').fill(monthAgo);
  await sheet.getByRole('button', { name: 'Add to my tally' }).click();
  const st = await page.evaluate(() => ({ base: window.state.baseline, j: window.state.journey, end: window.state.contract_end, total: window.journeyTotal() }));
  expect(st.base).toBe(to);
  expect(st.j).toHaveLength(1);
  expect(st.j[0].at).toBe(monthAgo);
  expect(st.end > monthAgo).toBe(true);
  expect(st.total).toBeCloseTo(st.j[0].per_year * 30 / 365, -1);
  await expect(page.locator('.me-tally')).toContainText('saved so far');
});

test('step 5: an ESB file keeps dated hourly readings, imports and exports, end-of-interval aware', async ({ page }) => {
  await boot(page);
  const m = await page.evaluate(() => {
    const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
    // 00:30 is 00:00–00:30 on the 5th; 00:00 on the 6th closes 23:30–24:00 of the 5th.
    rows.push('1,2,2,Active Import Interval (kW),05-10-2026 00:30');
    rows.push('1,2,4,Active Import Interval (kW),06-10-2026 00:00');
    rows.push('1,2,3,Active Export Interval (kW),05-10-2026 13:30');
    for (let i = 0; i < 20; i++) rows.push(`1,2,1,Active Import Interval (kW),05-10-2026 ${String(1 + (i % 22)).padStart(2, '0')}:30`);
    window.parseCsvHdf(rows.join('\n'), 'esb.csv');
    return window.state.meter.days['2026-10-05'];
  });
  expect(m[0]).toBeCloseTo(1);        // 2 kW for half an hour
  expect(m[23]).toBeCloseTo(2);       // the 00:00 reading belongs to the day before
  expect(m[24 + 13]).toBeCloseTo(1.5); // export, kept separately
});

test('step 5: a recorded switch is checked against the meter, and the score shows its parts', async ({ page }) => {
  const days = {};
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.now() - (40 - i) * 864e5).toISOString().slice(0, 10);
    days[d] = [...Array.from({ length: 24 }, (_, h) => (h < 7 ? 1.5 : h >= 17 && h < 19 ? 1 : 0.4)), ...new Array(24).fill(0)];
  }
  const at = Object.keys(days)[10];
  await boot(page, { current_screen: 'me', baseline: 'EN-SMART', meter: { days },
    journey: [{ type: 'switch', at, from: 'BG-24', to: 'EN-SMART', label: 'Switched to Energia Smart Data', per_year: 250 }] });
  const sc = await page.evaluate(() => window.householdScore());
  expect(sc.parts.map((p) => p.key)).toEqual(['plan', 'timing']);
  expect(sc.score).toBeGreaterThan(0);
  const chk = await page.evaluate(() => window.realityChecks()[0].r);
  expect(chk.days).toBe(30);
  await expect(page.locator('.sc')).toContainText('Checked on 30 days of your meter');
});

test('step 5: suggestions are fetched once, kept for the quarter, and carry no personal details', async ({ page }) => {
  await boot(page, { current_screen: 'me', user_email: 'me@example.ie', address: '1 Main St' });
  let sent = null;
  await page.route('**/api/advice', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ advice: { items: [
      { title: 'Run the dishwasher after 11pm', why: 'Night is 16.9c against 30.8c day.', saving_eur: 40, effort: 'easy' }] } }) });
  });
  await page.getByRole('button', { name: /Get this quarter's suggestions/ }).click();
  await expect(page.locator('.adv')).toContainText('Run the dishwasher after 11pm');
  const raw = JSON.stringify(sent);
  expect(raw).not.toContain('example.ie');
  expect(raw).not.toContain('Main St');
  expect(await page.evaluate(() => window.state.advice.items.length)).toBe(1);
});

test('the alert count shows on the My Peakless card in More, not only on the tab', async ({ page }) => {
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  await boot(page, { current_screen: 'more', contract_end: soon, alerts_seen: {} });
  await expect(page.locator('.me-entry-badge')).toBeVisible();
  await expect(page.locator('.me-entry')).toContainText('new alert');
});

test('"I switched plan" opens with the best plan for the home already chosen', async ({ page }) => {
  await boot(page, { current_screen: 'me', journey: [] });
  const best = await page.evaluate(() => window.getRecommendation().ranked.map((r) => r.plan.id).find((id) => id !== window.state.baseline));
  await page.getByRole('button', { name: /I switched plan/ }).click();
  await expect(page.locator('#jr-plan')).toHaveValue(best);
});

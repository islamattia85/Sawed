// @ts-check
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/*
 * What a tester found on his own home: panels up, a year of ESB readings, and
 * every figure wrong. The readings after the panels went in are what was left
 * after them, so read as the home's use they showed a 6,500 kWh home at a
 * fraction of that, his own panels paying back in decades, and every other
 * size never. The months since the panels began are now worked back.
 */
const HOME = { current_screen: 'solar', region: 'south', heating_type: 'heatpump', usage_input_mode: 'kwh', annual_kwh: 6500,
  baseline: 'EI-NB', baseline_known: true, meter_type: 'smart', has_solar: true, considering_solar: true, solar_planned: false,
  solar_is_estimate: false, count_A: 12, azimuth_A: 225, tilt_A: 35, count_B: 10, azimuth_B: 45, tilt_B: 35,
  install_cost: 10600, cost_is_manual: true, grant_eligible: false, grant_seai: 0 };

/** A year of readings the home would have, the panels going in on `install`. */
const withFile = (install) => `(() => {
  const id = getRecommendation().best.plan.id, s = sim(id);
  const gross = withSimState({ has_solar: false, battery_kwh: 0 }, () => Array.from(sim(id).cons));
  const imp = Array.from(s.grid_import), exp = Array.from(s.grid_export), days = {};
  for (let i = 0; i < 365; i++){
    const d = new Date(Date.UTC(2025, 9, 1 + i)), k = d.toISOString().slice(0, 10);
    const doy = Math.round((Date.UTC(2025, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2025, 0, 1)) / 864e5) % 365;
    const pre = k < '${install}', row = new Array(48).fill(0);
    for (let h = 0; h < 24; h++){ const j = doy * 24 + h; row[h] = +(pre ? gross[j] : imp[j]).toFixed(3); row[24 + h] = pre ? 0 : +exp[j].toFixed(3); }
    days[k] = row;
  }
  const truth = { kwh: Math.round(gross.reduce((a, b) => a + b, 0)), payback: v7SolarData().cur.payback };
  // As the importer leaves it: the year's use read from what was bought.
  const bi = {}; for (const [k, r] of Object.entries(days)){ const key = bimonthlyFor(+k.slice(5, 7) - 1).key; bi[key] = (bi[key] || 0) + r.slice(0, 24).reduce((a, x) => a + x, 0); }
  Object.assign(state, { meter: { days }, _csv_imported: true, usage_input_mode: 'csv', bills: bi });
  invalidate();
  const d = v7SolarData();
  return { truth, kwh: Math.round(Object.values(state.bills).reduce((a, b) => a + b, 0)), payback: d.cur.payback, basis: fileBasis() };
})()`;

for (const [battery, install] of [[9, '2025-10-20'], [0, '2026-04-01']]) {
  test(`a meter file from after the panels went in (${battery ? 'battery' : 'no battery'}, panels from ${install}) gives the home's real use and payback`, async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page, { ...HOME, battery_kwh: battery });
    const r = await page.evaluate(withFile(install));
    expect(r.basis.rebuilt, 'the day the panels began, from the file').toBe(install);
    expect(Math.abs(r.kwh - r.truth.kwh) / r.truth.kwh, `use: ${r.kwh} kWh, really ${r.truth.kwh}`).toBeLessThan(0.08);
    expect(Math.abs(r.payback - r.truth.payback), `payback ${r.payback}, really ${r.truth.payback}`).toBeLessThan(0.6);
    // Every other size is priced with panels, against the same home.
    const designs = await page.evaluate(() => sweepGoalDesigns().designs);
    expect(designs.filter((d) => d.payback < 25).length, designs.map((d) => `${d.panels}/${d.batt}: ${d.payback}`).join(', ')).toBeGreaterThan(6);
  });
}

test('sales that start partway are asked about, not guessed: panels up all year are priced from the readings', async ({ page }) => {
  test.setTimeout(120_000);
  // Panels and a battery up for the whole file, the battery soaking up winter's
  // spare solar, so nothing is sold until March.
  await boot(page, { ...HOME, battery_kwh: 9 });
  await page.evaluate(withFile('2025-01-01'));
  const basis = await page.evaluate(() => {
    const days = {};
    for (const [k, row] of Object.entries(state.meter.days)) days[k] = k < '2026-03-01' ? row.slice(0, 24).concat(new Array(24).fill(0)) : row;
    state.meter = { ...state.meter, days };
    invalidate();
    return fileBasis();
  });
  expect(basis.ask).toBe('since');
  expect(basis.since >= '2026-03-01').toBe(true);
  // "No, they were up for the whole file": the readings as they are.
  expect(await page.evaluate(() => { state.file_when = 'allyear'; invalidate(); const b = fileBasis(); return [b.mode, !!b.ask]; })).toEqual(['net', false]);
  // A what-if on another size still needs the home's use worked back.
  expect(await page.evaluate(() => withSimState({ count_A: state.count_A + 4 }, () => fileBasis().mode))).toBe('gross');
  // "Yes, around then": the days before are the home without panels.
  expect(await page.evaluate(() => { state.file_when = 'sinceyes'; invalidate(); const b = fileBasis(); return [b.mode, b.rebuilt === b.since, b.ask]; })).toEqual(['gross', true, null]);
});

test('no size is called the fastest payback, or the cheapest that still pays off, unless it pays back', async ({ page }) => {
  // A tiny use and no grant: nothing pays for itself.
  const bills = { 'Jan-Feb': 120, 'Mar-Apr': 100, 'May-Jun': 80, 'Jul-Aug': 80, 'Sep-Oct': 100, 'Nov-Dec': 120 };
  await boot(page, { has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, bills, grant_eligible: false, grant_seai: 0, grant_is_manual: true });
  const goals = await page.evaluate(() => { sweepGoalDesigns(); return designGoals().map((g) => ({ labels: g.labels, payback: g.d.payback, npv: g.d.npv })); });
  for (const g of goals) {
    if (g.labels.includes('Fastest payback') || g.labels.includes('Lowest cost')) expect(g.payback, JSON.stringify(g)).toBeLessThan(25);
  }
});

test('the quote check gives the Solar page’s payback for the system the home has, on a two-face roof', async ({ page }) => {
  await boot(page, { ...HOME, battery_kwh: 9 });
  const r = await page.evaluate(() => ({ q: auditQuote(10600, 22, 9), s: v7SolarData().cur }));
  expect(Math.round(r.q.totalAnnualBenefit)).toBe(Math.round(r.s.solarBenefit));
});

test('a planned system’s typed price moves with its size; panels already up keep what was paid', async ({ page }) => {
  await boot(page, { solar_planned: true, has_solar: true, count_A: 12, count_B: 0, battery_kwh: 5, install_cost: 11000, cost_is_manual: true });
  await page.evaluate(() => sysSet('count_A', 16));
  expect(await page.evaluate(() => state.install_cost)).toBeGreaterThan(11000);
  await boot(page, { solar_planned: false, has_solar: true, count_A: 12, count_B: 0, battery_kwh: 5, install_cost: 11000, cost_is_manual: true });
  await page.evaluate(() => sysSet('count_A', 16));
  expect(await page.evaluate(() => state.install_cost)).toBe(11000);
});

test('no old product email anywhere in the app', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => setScreen('methodology'));
  await expect(page.locator('#app-root')).not.toContainText('solaroptimiser');
});

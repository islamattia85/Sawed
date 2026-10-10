// @ts-check
// Real homes against what really happened. For each home in
// tests/fixtures/meter-scenarios/real/private/actuals.json (kept out of git:
// see that folder's README), the app is run on the home's meter file and its
// answers, and its months are set beside the months the home's own system
// recorded: made, used, bought, sold. Weather and habits differ from the
// typical year the app plans for, so the months are reported, not held to a
// tolerance. What is held: the plan the home is on is priced the way every
// figure says, with the battery filling in the plan's cheap hours (10 Oct 2026).
//
//     SCENARIO_OUT=/tmp/real npx playwright test real-actuals
//
// Skipped where the private file is not there (CI, any other machine).
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DIR, runScenario } from './run-scenario.js';

const PATH = DIR + 'real/private/actuals.json';
const HOMES = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : [];

test('real homes: a private actuals file is there', () => { test.skip(!HOMES.length, 'no real/private/actuals.json on this machine'); });

for (const h of HOMES) {
  test(`real home ${h.id}: the app's months beside the home's own @real`, async ({ page }) => {
    test.setTimeout(240_000);
    // Today's price list, not the frozen one the made-up homes use: these are real bills.
    const live = readFileSync(new URL('../../public/tariffs.json', import.meta.url));
    await page.route('**/tariffs.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: live }));
    const pg = new Proxy(page, { get(t, k) {
      if (k === 'route') return async (pat, fn) => (String(pat).includes('tariffs.json') ? undefined : t.route(pat, fn));
      const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
    } });
    await runScenario(pg, { id: h.id, files: [h.file], answers: h.answers, system: h.system });
    const app = await page.evaluate((months) => {
      const id = window.state.baseline, p = window.getPlanById(id), s = window.sim(id);
      const D = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], out = {};
      const cheap = (p.windows && (p.windows.ev || p.windows.night)) || null;
      const inCheap = (hr) => cheap && (cheap[0] < cheap[1] ? hr >= cheap[0] && hr < cheap[1] : hr >= cheap[0] || hr < cheap[1]);
      let i = 0, windowCharge = 0;
      for (let m = 0; m < 12; m++) {
        const o = { gen: 0, use: 0, bought: 0, boughtCheap: 0, sold: 0, charged: 0, discharged: 0, eur: 0 };
        for (let d = 0; d < D[m]; d++) for (let hr = 0; hr < 24; hr++, i++) {
          o.gen += s.gen[i]; o.use += s.cons[i]; o.bought += s.grid_import[i]; o.sold += s.grid_export[i];
          o.charged += s.battery_charge[i]; o.discharged += s.battery_discharge[i];
          o.eur += s.cost[i] - (s.revenue ? s.revenue[i] : 0);
          if (inCheap(hr)) { o.boughtCheap += s.grid_import[i]; windowCharge += s.battery_charge[i]; }
        }
        if (months[String(m + 1)]) out[m + 1] = o;
      }
      return { plan: id, rates: p.rates, exportRate: p.export_rate || 0, year: window.annualCost(s, p).net, cheap, windowCharge, out };
    }, h.months);
    // The figure rests on the setting it tells people to use.
    if (app.cheap && h.answers.battery > 0) expect(app.windowCharge, `${h.id}: the battery fills in ${app.plan}'s cheap hours`).toBeGreaterThan(100);
    const r = (x) => Math.round(x);
    const rows = Object.entries(h.months).map(([m, a]) => {
      const o = app.out[m]; const share = o.bought ? o.boughtCheap / o.bought : 1;
      const cheapRate = app.rates.ev ?? app.rates.night ?? app.rates.day, other = app.rates.day;
      const eurReal = a.bought * (share * cheapRate + (1 - share) * other) - a.sold * app.exportRate;
      return { month: +m, made: [r(o.gen), r(a.gen)], used: [r(o.use), r(a.use)], bought: [r(o.bought), r(a.bought)], sold: [r(o.sold), r(a.sold)], eur: [r(o.eur), r(eurReal)] };
    });
    const sum = (k, j) => rows.reduce((t, x) => t + x[k][j], 0);
    const report = { id: h.id, plan: app.plan, year: r(app.year), rows,
      total: { made: [sum('made', 0), sum('made', 1)], used: [sum('used', 0), sum('used', 1)], eur: [sum('eur', 0), sum('eur', 1)] },
      note: 'Each pair: [app, real]. EUR is power bought less power sold on the plan, before the standing charge; real months priced at the app\'s share of buying in the cheap hours.' };
    console.log(JSON.stringify(report, null, 1));
    if (process.env.SCENARIO_OUT) writeFileSync(`${process.env.SCENARIO_OUT}/${h.id}-actuals.json`, JSON.stringify(report, null, 1));
  });
}

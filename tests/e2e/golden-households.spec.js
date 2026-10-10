// @ts-check
// Golden households: a reference set of meter-file scenarios with known true
// answers, run through the real app on every push. A change to the model that
// moves any of these beyond its limit fails CI, so an accuracy regression
// cannot ship unnoticed.
//
// Limits (tests/fixtures/meter-scenarios/golden.json): where the app is within
// the agreed tolerance today (use and bill 5%, payback half a year, best plan
// or one within EUR 25), that tolerance; where it is not yet, today's error
// plus a small margin, so it can only get better. A fix that improves a known
// gap should tighten its limit in golden.json in the same change
// (make_golden.py only ever tightens). The warnings the import card gives and
// the questions asked are held too: once given, always given. And the
// accuracy figure shown must cover the error found where it does today, and
// may not shrink where it does not yet. The solar saving is held too (3%).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SCENARIOS, TRUTH, DIR, runScenario } from './run-scenario.js';

const GOLDEN = JSON.parse(readFileSync(DIR + 'golden.json', 'utf8'));

for (const [id, lim] of Object.entries(GOLDEN.scenarios)) {
  test(`golden: ${id}`, async ({ page }) => {
    test.setTimeout(120_000);
    const sc = SCENARIOS.find((s) => s.id === id);
    expect(sc, `scenario ${id} in scenarios.json`).toBeTruthy();
    const r = await runScenario(page, sc);
    if (lim.rejected) { expect(r.seen.rejected, 'the file is turned away with a message').toBeTruthy(); return; }
    expect(r.seen.rejected, String(r.seen.rejected)).toBeFalsy();
    const t = TRUTH[sc.truth];
    // Scored as tests/fixtures/meter-scenarios/score.py scores it: a home planning solar on its plans as
    // it is today (the app ranks plans with the planned panels in); a battery that only stores solar on
    // the app's answer for that, which the Plans page gives under its headline.
    let ranked = r.today || r.ranked;
    if (r.solarOnly && sc.truth !== 'hp_solar_gridfill' && !t.battery_per_plan) ranked = r.solarOnly;
    r.best = ranked[0].id; r.bestNet = ranked[0].net;
    if (lim.payback != null && t.payback) expect(r.solar, `${id}: the app shows a payback`).toBeTruthy();
    // Rounded to a tenth, as score.py reports them and as the limits were set.
    const tenth = (x) => Math.round(x * 10) / 10;
    const err = {
      kwh: tenth(Math.abs(r.kwh - t.use_kwh) / t.use_kwh * 100),
      bill: tenth(Math.abs(r.bestNet - t.costs[r.best]) / t.costs[r.best] * 100),
      plan: t.costs[r.best] - t.best_cost,
      payback: r.solar && t.payback ? tenth(Math.abs(tenth(r.solar.payback) - t.payback)) : null,
      saving: r.solar && t.saving ? tenth(Math.abs(r.solar.saving - t.saving) / t.saving * 100) : null,
    };
    const say = `${id}: use ${r.kwh} kWh (true ${t.use_kwh}), best ${r.best} €${r.bestNet} (true €${Math.round(t.costs[r.best])}; cheapest ${t.best} €${Math.round(t.best_cost)})` +
      (r.solar ? `, payback ${r.solar.payback.toFixed(1)} (true ${t.payback})` : '') + `, accuracy shown ±${r.accuracy.pct}%`;
    expect(err.kwh, say).toBeLessThanOrEqual(lim.kwh);
    expect(err.bill, say).toBeLessThanOrEqual(lim.bill);
    expect(err.plan, say).toBeLessThanOrEqual(lim.plan);
    if (lim.payback != null && err.payback != null) expect(err.payback, say).toBeLessThanOrEqual(lim.payback);
    if (lim.saving != null && err.saving != null) expect(err.saving, `${say}, solar saving €${Math.round(r.solar.saving)} (true €${Math.round(t.saving)})`).toBeLessThanOrEqual(lim.saving);
    // The plan the home is on, priced with the battery set for it as every other plan is.
    if (lim.current != null) {
      const cur = sc.answers.plan, mine = r.ranked.find((x) => x.id === cur);
      expect(mine, `${id}: the current plan ${cur} is priced`).toBeTruthy();
      expect(tenth(Math.abs(mine.net - t.costs[cur]) / t.costs[cur] * 100), `${say}; current plan ${cur} €${mine.net} (true €${Math.round(t.costs[cur])})`).toBeLessThanOrEqual(lim.current);
    }
    const asked = r.seen.questions.map((q) => q.q), warned = r.seen.warns.flat();
    for (const q of [].concat(lim.asks || [])) expect(asked, `${say}; asks ${q}`).toContain(q);
    for (const w of lim.warns || []) expect(warned, `${say}; warns ${w}`).toContain(w);
    if (lim.acc === 'covers') expect(r.accuracy.pct, `${say}; the accuracy shown covers the error`).toBeGreaterThanOrEqual(Math.max(err.kwh, err.bill));
    if (lim.acc_min != null) expect(r.accuracy.pct, `${say}; the accuracy shown does not shrink`).toBeGreaterThanOrEqual(lim.acc_min);
  });
}

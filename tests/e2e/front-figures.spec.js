// @ts-check
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { boot } from './support.js';

/**
 * The front page quotes real figures: what the same panels take to pay back
 * on the best plan and on a plan that pays nothing for export, what a big
 * system with a battery and a car earns on today's best plan, on a standard
 * plan, and on the plan that was withdrawn, and what the stress test says if
 * export pay halves.
 *
 * They are worked out here, on the app's own model, through the same setup a
 * visitor goes through. The page reads them from src/data/front-figures.json.
 * This test fails when the plans have moved far enough that the page would be
 * wrong; refresh the file with:
 *
 *   FRONT_FIGURES=write npx playwright test front-figures
 */
const FILE = new URL('../../src/data/front-figures.json', import.meta.url);
const WRITE = process.env.FRONT_FIGURES === 'write';

// A Dublin semi on gas heating, about 5,000 kWh a year, a south roof at 35°.
const setup = (o) => `(() => {
  startFlow('full');
  flowAnswer('bill', 'kwh:5000'); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban');
  flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0); flowAnswer('heat', 'gas'); flowAnswer('gas', 'no'); flowAnswer('night', 'no');
  flowAnswer('solar', 'thinking'); flowAnswer('where', 'east'); flowAnswer('house', 'semi'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35);
  flowAnswer('system', 'custom'); flowAnswer('panels', ${o.panels}); flowAnswer('battery', ${o.battery}); flowAnswer('price', 0); flowAnswer('grant', 'yes');
  flowAnswer('ev', '${o.ev ? 'thinking' : 'no'}');
  ${o.ev ? "flowAnswer('km', 16000); flowAnswer('car', 17);" : ''}
  flowFinish();
})()`;

/** Every plan's yearly cost for the home, with the system and without it. */
async function costs(page) {
  return page.evaluate(() => {
    const W = window.withSimState, R = window.getRecommendation, st = window.state;
    const list = () => Object.fromEntries(R().ranked.map((x) => [x.plan.id, Math.round(x.net)]));
    const withSys = list();
    const without = W({ has_solar: false, battery_kwh: 0 }, list);
    const best = R().ranked[0].plan.id;
    // The plans as served (window.TARIFFS is the copy bundled at load; the
    // served file replaces the model's list, so look each one up).
    const all = window.TARIFFS.map((p) => window.getPlanById(p.id) || p);
    // The withdrawn plan with the best export pay and a cheap EV window: priced
    // for this home as if it were still on sale.
    const gone = all.filter((p) => p.discontinued && p.windows && p.windows.ev && p.rates.ev)
      .sort((a, b) => (b.export_rate || 0) - (a.export_rate || 0))[0];
    let goneBill = null;
    if (gone) {
      gone.discontinued = false;
      try { goneBill = W({}, () => { const x = R().ranked.find((q) => q.plan.id === gone.id); return x ? Math.round(x.net) : null; }); }
      finally { gone.discontinued = true; window.invalidate(); }
    }
    const zero = all.filter((p) => !p.discontinued && !p.on_hold && !(p.export_rate > 0) && without[p.id] != null)
      .sort((a, b) => without[a.id] - without[b.id])[0];
    const top = R().ranked.slice(0, 4).map((x) => [x.plan.id, Math.round(x.net)]);
    return { withSys, without, best, top, gone: gone && gone.id, goneBill, zero: zero && zero.id,
      net: Math.round((st.install_cost || 0) - (st.grant_seai || 0)), payback: +window.v7SolarData().cur.payback.toFixed(1) };
  });
}

/** The Solar tab's stress test: payback today, if export halves, and if cheap nights end too. */
async function stress(page) {
  await page.evaluate(() => { stressSet('reset'); anTab('solar'); });
  const card = page.locator('#stress-card');
  await expect(card.locator('.st-ans')).toBeVisible({ timeout: 60000 });
  const n = (t) => (/never/.test(t) ? 99 : parseFloat(t.replace(/[^\d.]/g, '')));
  const read = async () => n(await card.locator('.st-ans b').first().innerText());
  const today = await read();
  await page.evaluate(() => stressSet('preset', 'half'));
  await expect(card).toContainText('today:', { timeout: 60000 });
  const half = await read();
  await page.evaluate(() => stressSet('preset', 'both'));
  await expect.poll(read, { timeout: 60000 }).not.toBe(half);
  const both = await read();
  return { today, half, both };
}

const yrs = (net, save) => +(net / save).toFixed(1);

test('the front page’s figures match the model on today’s plans', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, { onboarding_complete: false, current_screen: 'welcome' });

  // 12 panels, no battery, no car.
  await page.evaluate(setup({ panels: 12, battery: 0, ev: false }));
  const t = await costs(page);
  const tStress = await stress(page);
  const typical = {
    kwh: 5000, panels: 12, net: t.net, payback: t.payback,
    best_plan: t.best, best_bill: t.withSys[t.best], top: t.top,
    zero_plan: t.zero, zero_before: t.without[t.zero], zero_bill: t.withSys[t.zero],
    zero_payback: yrs(t.net, t.without[t.zero] - t.withSys[t.zero]),
    stress: tStress,
  };
  // The four bills the hero compares: today's plan with no panels, the best
  // plan with no panels, today's plan with the panels, the best plan with them.
  const switchId = Object.entries(t.without).sort((a, b) => a[1] - b[1])[0][0];
  typical.ladder = {
    plan: 'EI-24', now: t.without['EI-24'],
    switch_plan: switchId, switch: t.without[switchId],
    solar_stay: t.withSys['EI-24'], solar_best: t.withSys[t.best],
    stay_payback: yrs(t.net, t.without['EI-24'] - t.withSys['EI-24']),
  };

  // 16 panels, a 10 kWh battery and an electric car, from a standard plan.
  await page.evaluate(setup({ panels: 16, battery: 10, ev: true }));
  const b = await costs(page);
  const bStress = await stress(page);
  const before = b.without['EI-24'];
  const big = {
    panels: 16, battery: 10, km: 16000, net: b.net, payback: b.payback,
    before_plan: 'EI-24', before,
    stay_bill: b.withSys['EI-24'], stay_payback: yrs(b.net, before - b.withSys['EI-24']),
    best_plan: b.best, best_bill: b.withSys[b.best], best_payback: yrs(b.net, before - b.withSys[b.best]),
    gone_plan: b.gone, gone_bill: b.goneBill, gone_payback: b.goneBill == null ? null : yrs(b.net, before - b.goneBill),
    stress: bStress,
  };
  const bSwitch = Object.entries(b.without).sort((a, c) => a[1] - c[1])[0][0];
  big.ladder = { plan: 'EI-24', now: before, switch_plan: bSwitch, switch: b.without[bSwitch],
    solar_stay: b.withSys['EI-24'], solar_best: b.withSys[b.best], stay_payback: big.stay_payback, best_payback: big.best_payback };
  const now = { worked_out: new Date().toISOString().slice(0, 10), typical, big };

  if (WRITE) {
    mkdirSync(new URL('.', FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(now, null, 2) + '\n');
    console.log(JSON.stringify(now, null, 2));
    return;
  }
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  const near = (a, b, tol, what) => expect(Math.abs(a - b), `${what}: page says ${b}, the model now says ${a}. Refresh with FRONT_FIGURES=write`).toBeLessThanOrEqual(tol);
  for (const k of ['payback', 'zero_payback']) near(typical[k], saved.typical[k], 0.6, `typical.${k}`);
  for (const k of ['today', 'half', 'both']) near(typical.stress[k], saved.typical.stress[k], 0.6, `typical.stress.${k}`);
  for (const k of ['payback', 'stay_payback', 'best_payback', 'gone_payback']) near(big[k], saved.big[k], 0.6, `big.${k}`);
  near(typical.net, saved.typical.net, 400, 'typical.net');
  for (const k of ['now', 'switch', 'solar_stay', 'solar_best']) near(typical.ladder[k], saved.typical.ladder[k], 120, `typical.ladder.${k}`);
  near(typical.ladder.stay_payback, saved.typical.ladder.stay_payback, 0.6, 'typical.ladder.stay_payback');
  near(typical.best_bill, saved.typical.best_bill, 120, 'typical.best_bill');
  near(big.net, saved.big.net, 600, 'big.net');
  expect(typical.zero_plan, 'a plan that pays nothing for export still exists').toBeTruthy();
});

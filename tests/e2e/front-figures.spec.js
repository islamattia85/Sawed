// @ts-check
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { boot } from './support.js';

/**
 * The front page quotes real figures: one home's four yearly bills (as it is,
 * a new plan only, panels on the old plan, panels on the plan that suits
 * them) and what the same panels take to pay back on the old plan and on the
 * best one. "Why the plan matters" names the withdrawn plan it describes.
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

// A Dublin semi on gas heating, about 5,000 kWh a year, a south roof at 35°,
// 16 panels, a 10 kWh battery and an electric car, from a standard plan.
const SETUP = `(() => {
  startFlow('full');
  flowAnswer('bill', 'kwh:5000'); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban');
  flowAnswer('plan', 'EI-24'); flowAnswer('disc', 0); flowAnswer('heat', 'gas'); flowAnswer('gas', 'no'); flowAnswer('night', 'no');
  flowAnswer('solar', 'thinking'); flowAnswer('where', 'east'); flowAnswer('house', 'semi'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35);
  flowAnswer('system', 'custom'); flowAnswer('panels', 16); flowAnswer('battery', 10); flowAnswer('price', 0); flowAnswer('grant', 'yes');
  flowAnswer('ev', 'thinking'); flowAnswer('km', 16000); flowAnswer('car', 17);
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
    // The withdrawn plan with the best export pay and a cheap EV window.
    const gone = all.filter((p) => p.discontinued && p.windows && p.windows.ev && p.rates.ev)
      .sort((a, b) => (b.export_rate || 0) - (a.export_rate || 0))[0];
    return { withSys, without, best, gone: gone && gone.id, net: Math.round((st.install_cost || 0) - (st.grant_seai || 0)) };
  });
}

const yrs = (net, save) => +(net / save).toFixed(1);

test('the front page’s figures match the model on today’s plans', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, { onboarding_complete: false, current_screen: 'welcome' });
  await page.evaluate(SETUP);
  const b = await costs(page);
  const now = b.without['EI-24'];
  const switchId = Object.entries(b.without).sort((x, y) => x[1] - y[1])[0][0];
  const big = {
    panels: 16, battery: 10, km: 16000, net: b.net, gone_plan: b.gone,
    ladder: {
      plan: 'EI-24', now, switch: b.without[switchId],
      solar_stay: b.withSys['EI-24'], solar_best: b.withSys[b.best],
      stay_payback: yrs(b.net, now - b.withSys['EI-24']), best_payback: yrs(b.net, now - b.withSys[b.best]),
    },
  };
  const fresh = { worked_out: new Date().toISOString().slice(0, 10), big };

  if (WRITE) {
    mkdirSync(new URL('.', FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(fresh, null, 2) + '\n');
    console.log(JSON.stringify(fresh, null, 2));
    return;
  }
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  const near = (a, b, tol, what) => expect(Math.abs(a - b), `${what}: page says ${b}, the model now says ${a}. Refresh with FRONT_FIGURES=write`).toBeLessThanOrEqual(tol);
  near(big.net, saved.big.net, 600, 'big.net');
  for (const k of ['now', 'switch', 'solar_stay', 'solar_best']) near(big.ladder[k], saved.big.ladder[k], 120, `big.ladder.${k}`);
  for (const k of ['stay_payback', 'best_payback']) near(big.ladder[k], saved.big.ladder[k], 0.6, `big.ladder.${k}`);
  expect(big.gone_plan, 'a withdrawn plan with an EV window is still on file').toBeTruthy();
});

// @ts-check
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { boot } from './support.js';

/**
 * The front page quotes real figures: one home's four yearly bills (as it is,
 * a new plan only, panels on the old plan, panels on the plan that suits
 * them) and what the same panels take to pay back on the old plan and on the
 * best one. "Why the plan matters" names the withdrawn plan it describes. The
 * pictures under "What you get" draw a smaller home: 12 panels, no battery,
 * no car, its payback, its four cheapest plans, its months on its plan now
 * and on the best one, and its report's length.
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
// from a standard plan.
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
    // The withdrawn plan with the best export pay and a cheap EV window.
    const gone = all.filter((p) => p.discontinued && p.windows && p.windows.ev && p.rates.ev)
      .sort((a, b) => (b.export_rate || 0) - (a.export_rate || 0))[0];
    const top = R().ranked.slice(0, 4).map((x) => [x.plan.id, Math.round(x.net)]);
    return { withSys, without, best, top, gone: gone && gone.id, net: Math.round((st.install_cost || 0) - (st.grant_seai || 0)),
      grant: Math.round(st.grant_seai || 0), payback: +window.v7SolarData().cur.payback.toFixed(1) };
  });
}

/** The home's months: its plan now without the system, and the best plan with it (below zero: in credit). */
async function months(page, now, best) {
  return page.evaluate(([n, b]) => ({
    now: window.withSimState({ has_solar: false, battery_kwh: 0 }, () => window.__sim.monthNet(n)).map(Math.round),
    best: window.__sim.monthNet(b).map(Math.round),
  }), [now, best]);
}

/** How many pages the home's report runs to. */
async function reportPages(page) {
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  const pdf = readFileSync(await (await download).path()).toString('latin1');
  return (pdf.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
}

const yrs = (net, save) => +(net / save).toFixed(1);

test('the front page’s figures match the model on today’s plans', async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, { onboarding_complete: false, current_screen: 'welcome' });

  // 12 panels, no battery, no car: the pictures.
  await page.evaluate(setup({ panels: 12, battery: 0, ev: false }));
  const t = await costs(page);
  const typical = { panels: 12, grant: t.grant, net: t.net, payback: t.payback, now: t.without['EI-24'], top: t.top,
    months: await months(page, 'EI-24', t.best), report_pages: await reportPages(page) };

  // 16 panels, a 10 kWh battery and an electric car: the four-bill card.
  await page.evaluate(setup({ panels: 16, battery: 10, ev: true }));
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
  const fresh = { worked_out: new Date().toISOString().slice(0, 10), typical, big };

  if (WRITE) {
    mkdirSync(new URL('.', FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(fresh, null, 2) + '\n');
    console.log(JSON.stringify(fresh, null, 2));
    return;
  }
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));
  const near = (a, b, tol, what) => expect(Math.abs(a - b), `${what}: page says ${b}, the model now says ${a}. Refresh with FRONT_FIGURES=write`).toBeLessThanOrEqual(tol);
  near(typical.payback, saved.typical.payback, 0.6, 'typical.payback');
  near(typical.net, saved.typical.net, 400, 'typical.net');
  near(typical.now, saved.typical.now, 120, 'typical.now');
  for (const [i, [, c]] of saved.typical.top.entries()) near(typical.top[i][1], c, 120, `typical.top.${i}`);
  for (const k of ['now', 'best']) for (const [i, v] of saved.typical.months[k].entries()) near(typical.months[k][i], v, 20, `typical.months.${k}.${i}`);
  expect(typical.grant, 'typical.grant').toBe(saved.typical.grant);
  expect(typical.report_pages, 'typical.report_pages').toBe(saved.typical.report_pages);
  near(big.net, saved.big.net, 600, 'big.net');
  for (const k of ['now', 'switch', 'solar_stay', 'solar_best']) near(big.ladder[k], saved.big.ladder[k], 120, `big.ladder.${k}`);
  for (const k of ['stay_payback', 'best_payback']) near(big.ladder[k], saved.big.ladder[k], 0.6, `big.ladder.${k}`);
  expect(big.gone_plan, 'a withdrawn plan with an EV window is still on file').toBeTruthy();
});

/**
 * The pictures under "What you get" draw the example home from the file, not
 * from typed-in numbers (30 Oct 2026): the month chart's bars added up to
 * €896 a year under a "−€1,260" heading, no month went into credit under a
 * caption about summer credit, the report card said "Could save €1,822" and
 * "13 pages", and the ranking read "Cheaper at night" three times.
 */
test('the front page’s pictures show the example home’s own figures', async ({ page }) => {
  const fig = JSON.parse(readFileSync(FILE, 'utf8')).typical;
  const eur = (n) => `€${Math.round(n).toLocaleString('en-IE')}`;
  const save = fig.now - fig.top[0][1];
  await boot(page, { onboarding_complete: false, current_screen: 'welcome' }, '/');
  const card = (h) => page.locator('.wl-showcard', { has: page.locator('h3', { hasText: h }) }).locator('svg');

  await expect(card('Solar payback')).toContainText(`${fig.panels} panels, after the ${eur(fig.grant)} grant`);
  await expect(card('Solar payback')).toContainText(`pays back · ${fig.payback.toFixed(1)} yrs`);

  // The month chart: the heading is what its bars add up to, and the months in credit go below the line.
  const month = card('Your bill, month by month');
  await expect(month).toContainText(`${eur(save)} less a year`);
  const sums = fig.months.now.reduce((a, b) => a + b) - fig.months.best.reduce((a, b) => a + b);
  expect(Math.abs(sums - save), 'the bars add up to the heading').toBeLessThanOrEqual(20);
  const below = await month.evaluate((svg) => {
    const y0 = +svg.querySelector('line.axis').getAttribute('y1');
    return [...svg.querySelectorAll('rect.acc')].filter((r) => +r.getAttribute('y') >= y0 - 0.01 && +r.getAttribute('height') > 1.5).length;
  });
  expect(below).toBe(fig.months.best.filter((v) => v < 0).length);
  expect(below, 'the example home is in credit in summer').toBeGreaterThan(0);

  // The report card: the same saving, and the report's own length.
  await expect(card('The report')).toContainText(`Could save${eur(save)}a year`);
  await expect(card('The report')).toContainText(`${fig.report_pages} pages`);

  // The ranking names each plan's supplier, cheapest first.
  const ranked = card('Every plan, ranked');
  const suppliers = await page.evaluate((ids) => ids.map((id) => window.getPlanById(id).supplier), fig.top.slice(0, 3).map(([id]) => id));
  for (const [i, s] of suppliers.entries()) await expect(ranked).toContainText(`${i + 1}. ${s}`);
  await expect(ranked).toContainText(eur(fig.top[0][1]));
  await expect(ranked).not.toContainText('Cheaper at night');
});

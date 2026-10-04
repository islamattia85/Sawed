/**
 * Simulated homes: many random but realistic households pushed through every
 * screen, checking the app never errors and its figures agree with each other.
 * Seeded, so a failure names the home and reproduces exactly.
 */
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const PLANS = ['EI-24', 'EI-SST', 'EI-NB', 'BG-24', 'BG-TOU', 'BG-EV', 'EN-SMART-24-HOUR', 'EN-SMART', 'EN-EV', 'EN-24',
  'SSE-24', 'SSE-DNP', 'SSE-EVMAX', 'YN-24', 'YN-EV', 'FL-24', 'FL-EV', 'PIN-LF', 'PPP-24', 'CP-24'];
const REGIONS = ['east', 'south', 'west', 'northwest', 'midlands'];
const HEAT = ['gas', 'heatpump', 'storage', 'direct'];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function home(seed) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)], int = (a, b) => a + Math.floor(r() * (b - a + 1));
  const solar = pick(['none', 'none', 'have', 'planned']);
  const two = solar !== 'none' && r() < 0.3;
  const ev = pick(['no', 'no', 'have', 'planned']);
  const heat = pick(HEAT);
  return {
    seed, current_screen: 'result', region: pick(REGIONS), heating_type: heat,
    baseline: pick(PLANS), baseline_known: r() < 0.85,
    bimonthly_bill_eur: int(60, 800), grant_eligible: r() < 0.8,
    has_solar: solar !== 'none', considering_solar: solar !== 'none',
    solar_planned: solar === 'planned', solar_is_estimate: solar === 'planned' && r() < 0.5,
    count_A: solar === 'none' ? 0 : int(4, 18), count_B: two ? int(2, 10) : 0,
    azimuth_A: pick([90, 135, 180, 225, 270]), azimuth_B: pick([90, 270, 225, 135]), tilt_A: int(15, 45), tilt_B: int(15, 45),
    battery_kwh: solar === 'none' ? 0 : pick([0, 0, 5, 9, 10, 13]),
    install_cost: 0, grant_seai: 0,
    ev_active: ev !== 'no', ev_in_bill: ev === 'have', ev_km_per_year: int(5000, 30000), ev_kwh_per_100km: pick([14, 17, 20]),
    gas_same_supplier: heat === 'gas' ? pick(['', 'yes', 'no']) : '', gas_bill_eur: pick([0, 120, 220, 400]),
    contract_end_date: r() < 0.5 ? '2027-04-01' : '',
  };
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const SEEDS = Array.from({ length: Number(process.env.SIM_N || 40) }, (_, i) => 1000 + i * 7919);

for (const seed of SEEDS) {
  test(`simulated home ${seed}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.clock.setFixedTime(new Date('2026-10-04T12:00:00Z'));
    const h = home(seed);
    const reported = [];
    page.on('request', (req) => { if (req.url().includes('/api/error')) reported.push(req.postData()); });
    const errors = await boot(page, h);
    // Usage from the bill, as setup and My home work it out.
    await page.evaluate((b) => { state.bimonthly_bill_eur = -1; homeSet('bimonthly_bill_eur', String(b)); }, h.bimonthly_bill_eur);
    const ctx = JSON.stringify(h);

    // Figures that must agree with each other.
    const f = await page.evaluate(() => {
      const rec = getRecommendation();
      const own = rec.ranked.find((x) => x.plan.id === state.baseline);
      let pl = null; try { pl = (state.solar_planned || state.solar_is_estimate) && state.has_solar ? window.__sim.plannedLadder() : null; } catch (e) { pl = { err: String(e) }; }
      let df = null; try { df = window.__sim.dualFuel(); } catch (e) { df = { err: String(e) }; }
      return {
        base: rec.baseCost, best: rec.best && rec.best.net, bestPlan: rec.best && rec.best.plan && rec.best.plan.id,
        bestType: rec.best && rec.best.plan && rec.best.plan.type, savings: rec.best && rec.best.savings,
        n: rec.ranked.length, own: own ? own.net : null, ownRankable: !!own, nets: rec.ranked.map((x) => x.net),
        grant: state.grant_seai, eligible: state.grant_eligible, cost: state.install_cost, hasSolar: state.has_solar,
        pl, df, hasEv: state.ev_active,
      };
    });
    expect(f.n, ctx).toBeGreaterThan(5);
    for (const v of [f.base, f.best, ...f.nets]) expect(finite(v), ctx).toBe(true);
    if (!f.hasSolar) expect(f.best, ctx).toBeGreaterThan(0);   // with panels, a year can earn more than it costs
    expect(f.bestType, ctx).not.toBe('dynamic');                       // wholesale plans are never ranked
    expect(Math.min(...f.nets), ctx).toBeGreaterThanOrEqual(f.best - 0.5);   // best is the cheapest
    if (!f.hasSolar && !f.hasEv) {                                       // same house on both sides
      expect(f.best, ctx).toBeLessThanOrEqual(f.base + 0.5);
      if (f.own != null) expect(Math.abs(f.own - f.base), ctx).toBeLessThan(1);
    }
    if (!f.eligible) expect(f.grant, ctx).toBe(0);
    if (f.hasSolar) expect(f.cost, `install cost ${ctx}`).toBeGreaterThan(0);
    if (f.pl) {
      expect(f.pl.err, ctx).toBeUndefined();
      for (const v of [f.pl.today, f.pl.noSolar.net, f.pl.mine, f.pl.best.net]) expect(finite(v), ctx).toBe(true);
      expect(f.pl.noSolar.net, ctx).toBeLessThanOrEqual(f.pl.today + 0.5);
      expect(f.pl.best.net, ctx).toBeLessThanOrEqual(f.pl.mine + 0.5);
    }
    if (f.df) {
      expect(f.df.err, ctx).toBeUndefined();
      for (const o of [f.df.stay, f.df.moveElec, f.df.moveBoth].filter(Boolean)) {
        expect(finite(o.total), ctx).toBe(true);
        expect(Math.abs(o.total - o.elec - o.gas), ctx).toBeLessThan(0.01);
        expect(o.gas, ctx).toBeGreaterThan(0);
      }
      if (f.df.moveElec) expect(f.df.moveElec.lost, ctx).toBeGreaterThanOrEqual(-0.01);
    }

    // Independent arithmetic: a flat plan's year is kWh × rate + standing + PSO,
    // plus an announced rise for the part of the year after it starts.
    if (!f.hasSolar && !f.hasEv) {
      const flat = await page.evaluate(() => {
        const kwh = window.__sim.annualKwh(), pso = window.__sim.pso, now = Date.now();
        return getRecommendation().ranked.filter((x) => x.plan.type === 'flat' && !x.plan.weekend).map((x) => {
          const p = x.plan, pc = p.price_change; let w = 0;
          if (pc && pc.effective_date) { const d = (Date.parse(pc.effective_date + 'T00:00:00Z') - now) / 864e5; if (d > 0 && d < 365) w = (365 - d) / 365; }
          const energy = kwh * p.rates.day;
          const rise = w * (energy * ((pc && pc.pct_bands && pc.pct_bands.day != null) ? pc.pct_bands.day : (pc ? pc.pct || 0 : 0)) + p.standing * (pc ? pc.standing_pct || 0 : 0));
          return { id: p.id, app: x.net, hand: energy + p.standing + pso + rise };
        });
      });
      for (const x of flat) expect(Math.abs(x.app - x.hand), `${x.id} app €${x.app.toFixed(2)} vs by hand €${x.hand.toFixed(2)} ${ctx}`).toBeLessThan(1);
    }

    // The bill typed in comes back out: the current plan's year, before any
    // announced rise, is six two-monthly bills (the usage is worked out from it).
    if (!f.hasSolar && !(h.ev_active && h.ev_in_bill)) {
      const b = await page.evaluate(() => { const p = getPlanById(state.baseline); const bs = window.__sim.baselineNet();
        return { year: bs, bill: state.bimonthly_bill_eur, mode: state.usage_input_mode, rise: !!(p.price_change && Date.parse(p.price_change.effective_date) > Date.now()) }; });
      if (b.mode !== 'kwh' && !b.rise) expect(Math.abs(b.year - b.bill * 6) / (b.bill * 6), `year €${b.year.toFixed(0)} vs bill ×6 €${b.bill * 6} ${ctx}`).toBeLessThan(0.03);
    }

    // What Home shows matches the model, and no "NaN", "undefined" or "Infinity" anywhere.
    const bad = /NaN|undefined|Infinity|\[object Object\]|null €|€null/;
    const visit = async (label, go) => {
      await page.evaluate((s) => (0, eval)(s), go);
      await page.waitForTimeout(350);
      const txt = await page.locator('#app-root').innerText();
      expect(txt.match(bad), `${label} ${ctx}`).toBeNull();
    };
    await visit('home', "v7Sheet(null); setScreen('result')");
    await visit('plans', "setScreen('plans')");
    await visit('plan sheet', "v7Sheet('plan', getRecommendation().ranked[0].plan.id)");
    await visit('switch sheet', "v7Sheet('switch', getRecommendation().best.plan.id)");
    for (const t of ['bill', 'hours', 'solar', 'car', 'accuracy']) await visit(`analytics ${t}`, `v7Sheet(null); setScreen('analytics'); anTab('${t}')`);
    await visit('me', "setScreen('me')");
    await visit('my home', 'openMyHome()');
    await visit('my system', "v7Sheet(null); openMySystem()");
    if (f.hasSolar) await visit('quick change', "v7Sheet(null); setScreen('analytics'); anTab('solar'); openQuickSystem(); qsStep('a', 1)");
    await visit('privacy', "v7Sheet(null); setScreen('privacy')");

    expect(errors, ctx).toEqual([]);
    expect(reported, ctx).toEqual([]);
  });
}

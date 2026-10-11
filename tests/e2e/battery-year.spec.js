// @ts-check
/**
 * The battery, checked over a whole year, not one day (11 Oct 2026). Every
 * figure says it fills in the plan's cheap hours where that pays and runs the
 * house in its dear ones. On a heat pump home with panels and a 9 kWh battery,
 * on three plans with a cheap night window:
 *
 * - every day, it is full by the end of the cheapest hours;
 * - it does not leave the house buying at the dear rate while it still holds
 *   charge above its reserve (a few kWh a year at the edges of an hour);
 * - a battery written here, apart from the app's (fill to full in the cheap
 *   hours, run the house in the dear ones, store spare solar), prices the year
 *   within a few euros of the app.
 */
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const HOME = { has_solar: true, solar_planned: false, considering_solar: false, count_A: 10, count_B: 0, panel_w: 460, azimuth_A: 157, tilt_A: 35,
  battery_kwh: 9, heating_type: 'heatpump', region: 'south', baseline: 'EN-EV', baseline_known: true, bimonthly_bill_eur: 300, usage_input_mode: 'bill',
  grid_charge_now: 'yes', bill_when: 'before' };

const inwin = (h, w) => (w[0] < w[1] ? h >= w[0] && h < w[1] : h >= w[0] || h < w[1]);

/** The battery written apart from the app's: what the year's power costs and earns on plan p. */
function simple(p, b) {
  const R = p.rates, w = p.windows || {};
  const cheap = ['ev', 'night'].filter((k) => w[k]).map((k) => [R[k] ?? R.day, k]).sort((x, y) => x[0] - y[0]);
  const dear = Math.max(R.day, w.peak && R.peak ? R.peak : 0);
  const [cr, cb] = cheap[0], win = w[cb];
  const next = cheap[1] && cheap[1][0] / b.eff < dear - 0.01 ? cheap[1][1] : null;
  const one = Math.sqrt(b.eff), lo = b.min * b.cap, hi = b.cap, rate = Math.max(2.5, Math.min(6, b.cap * 0.5));
  let soc = lo, money = 0;
  for (let i = 0; i < 8760; i++) {
    const h = i % 24, band = p.band[i] || 'day', net = p.cons[i] - p.gen[i];
    const fill = cr / b.eff < dear - 0.01 && (inwin(h, win) || (next && win[0] < win[1] && h >= win[1] && h < 12 && inwin(h, w[next])));
    let imp = 0, exp = 0;
    if (net < 0) { const c = Math.min(-net, (hi - soc) / one, rate); soc += c * one; exp = -net - c; }
    else if (fill) { const c = Math.min((hi - soc) / one, rate); soc += c * one; imp = net + c; }
    else if (band === 'day' || band === 'peak') { const d = Math.min(Math.max(0, soc - lo), net / one, b.inv); soc -= d; imp = net - d * one; }
    else imp = net;
    money += imp * (R[band] ?? R.day) - exp * (p.export_rate || 0);
  }
  return money;
}

test('over a whole year the battery fills in the cheap hours every day, runs the house in the dear ones, and a separate battery agrees on the cost', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page, HOME);
  const d = await page.evaluate(() => {
    const st = window.state;
    const one = (id) => { const s = window.sim(id), p = window.getPlanById(id), a = window.annualCost(s, p); const arr = (x) => Array.from(x);
      return { id, energy: a.energy_cost, revenue: a.export_revenue, strategy: s.strategy_used, windows: p.windows, rates: p.rates, export_rate: p.export_rate,
        cons: arr(s.cons), gen: arr(s.gen), soc: arr(s.soc), dis: arr(s.battery_discharge), imp: arr(s.grid_import), band: arr(s.band) }; };
    return { b: { cap: st.battery_kwh, min: st.battery_min, eff: st.battery_eff, inv: st.inverter_kw }, plans: ['EN-EV', 'EI-NB', 'YN-EV-DNP'].map(one) };
  });
  const { b } = d, lo = b.min * b.cap;
  for (const p of d.plans) {
    expect(p.strategy, `${p.id} is costed with the battery filling at night`).toBe('arbitrage');
    const w = p.windows, cheap = w.ev || w.night;
    // Full by the end of the cheapest hours. (On Night Boost the night hours after them, at 18.5c,
    // cost more than export pays, so from 04:00 it keeps what the day needs and runs the house on the rest.)
    const by = cheap[1];
    const short = [];
    for (let day = 0; day < 365; day++) if (p.soc[day * 24 + by] < b.cap - 0.1) short.push(day);
    expect(short, `${p.id}: days not full by ${by}:00`).toEqual([]);
    // Dear hours bought while the battery held charge above its reserve.
    let dearUse = 0, missed = 0;
    for (let i = 0; i < 8760; i++) {
      if (p.band[i] !== 'day' && p.band[i] !== 'peak') continue;
      dearUse += Math.max(0, p.cons[i] - p.gen[i]);
      if (p.soc[i] > lo + 0.05 && p.imp[i] > 0.01) missed += p.imp[i];
    }
    expect(missed / dearUse, `${p.id}: ${missed.toFixed(0)} of ${dearUse.toFixed(0)} dear kWh bought with charge left`).toBeLessThan(0.03);
  }
  // The separate battery, on the plans whose night hours it treats as the app does.
  for (const p of d.plans.filter((x) => x.id !== 'YN-EV-DNP')) {
    const app = p.energy - p.revenue, mine = simple(p, b);
    expect(Math.abs(app - mine), `${p.id}: the app ${app.toFixed(0)}, a separate battery ${mine.toFixed(0)}`).toBeLessThan(10);
  }
  expect(errors).toEqual([]);
});

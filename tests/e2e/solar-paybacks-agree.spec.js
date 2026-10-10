// @ts-check
/**
 * The Solar page gives the payback twice: "Pays for itself in" at the top and
 * "Pays back in … at today's prices" under "If prices change". The two kept
 * their figures under different lists of what they depend on, so a change on
 * one list only (the panels' wattage, the hot water) left one of them from
 * before it: 7.3 years over 7.5 on one phone (10 Oct 2026).
 */
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

const HOME = { has_solar: true, solar_planned: false, considering_solar: false, count_A: 10, count_B: 0, panel_w: 460, azimuth_A: 157, tilt_A: 35,
  battery_kwh: 9, heating_type: 'heatpump', region: 'south', baseline: 'EN-EV', baseline_known: true, bimonthly_bill_eur: 300, usage_input_mode: 'bill',
  grid_charge_now: 'yes', bill_when: 'before', cost_is_manual: true, install_cost: 11200, grant_eligible: false, grant_seai: 0 };

/** Both paybacks and both twenty-year figures, once the stress test has finished. */
async function both(page) {
  await page.waitForFunction(() => {
    const c = document.querySelector('#stress-card');
    return c && !c.querySelector('.fl-working') && /Pays back in/.test(c.textContent);
  }, null, { timeout: 60_000 });
  return page.evaluate(() => {
    const top = document.querySelector('.ax-ans').innerText.replace(/\s+/g, ' ');
    const st = document.querySelector('#stress-card').innerText.replace(/\s+/g, ' ');
    const n = (t, re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
    return { top: n(top, /Pays for itself in ([\d.]+)/), stress: n(st, /Pays back in ([\d.]+) years/),
      topLife: n(top, /€([\d,]+) ahead in 20 years/), stressLife: n(st, /After 20 years €([\d,]+)/), text: `${top} || ${st}` };
  });
}

test('the two paybacks on the Solar page agree, and stay agreed when the system or the home changes', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page, HOME);
  await page.evaluate(() => window.anTab('solar'));
  const check = async (why) => {
    const r = await both(page);
    expect(r.top, `${why}: ${r.text}`).not.toBeNull();
    expect(r.stress, `${why}: ${r.text}`).toBe(r.top);
    expect(Math.abs(r.stressLife - r.topLife), `${why}: ${r.text}`).toBeLessThanOrEqual(1);
    return r;
  };
  const a = await check('as set up');
  // Each of these was on one card's list and not the other's.
  for (const [k, v] of [['panel_w', 400], ['hot_water_strategy', 'none'], ['inverter_kw', 3]]) {
    await page.evaluate(([k, v]) => { window.state[k] = v; window.invalidate(); window.renderApp(); }, [k, v]);
    await check(`after ${k} = ${v}`);
  }
  const b = await both(page);
  expect(b.top, 'the changes did change the answer').not.toBe(a.top);
  expect(errors).toEqual([]);
});

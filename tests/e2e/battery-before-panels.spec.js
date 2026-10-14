// @ts-check
import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/*
 * The owner's own ESB file (14 Oct 2026): his battery went in and charged from
 * the grid every night, about 10 kWh between 2 and 4am, twelve days before the
 * meter first recorded a sale. Those twelve days were read as his home's own
 * use, ten kWh in the small hours each night. The system's start is now the
 * battery's first night of grid charging, where the person says there is a
 * battery and no car charging in the file: a car charged each night looks the
 * same, and reading a car into a meter file nobody said had one is the
 * mistake this must not make.
 */
const HOME = { current_screen: 'solar', region: 'south', heating_type: 'heatpump', usage_input_mode: 'kwh', annual_kwh: 5500,
  baseline: 'EN-EV', baseline_known: true, meter_type: 'smart', has_solar: true, considering_solar: true, solar_planned: false,
  solar_is_estimate: false, count_A: 10, azimuth_A: 157, tilt_A: 35, count_B: 0, panel_w: 460,
  install_cost: 10000, cost_is_manual: true, grant_eligible: false, grant_seai: 0, ev_active: false, ev_in_bill: false };

const BATTERY = '2026-03-10', PANELS = '2026-04-01';

/**
 * A year of readings: the home's own use until the battery, then the same use
 * with the battery filling from the grid at 2 and 3am (5 kWh an hour) and
 * giving 9 kWh back in the evening, then what the model's system buys and
 * sells once the panels are up. `night` sets the battery's nightly fill.
 */
const withFile = (night = 10) => `(() => {
  const id = state.baseline, s = sim(id);
  const gross = withSimState({ has_solar: false, battery_kwh: 0 }, () => Array.from(sim(id).cons));
  const imp = Array.from(s.grid_import), exp = Array.from(s.grid_export), days = {};
  for (let i = 0; i < 365; i++){
    const d = new Date(Date.UTC(2025, 9, 1 + i)), k = d.toISOString().slice(0, 10);
    const doy = Math.round((Date.UTC(2025, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2025, 0, 1)) / 864e5) % 365;
    const row = new Array(48).fill(0);
    for (let h = 0; h < 24; h++){
      const j = doy * 24 + h;
      if (k < '${BATTERY}') row[h] = gross[j];
      else if (k < '${PANELS}'){
        // Battery only: the night fill on top, the evening taken back off.
        let v = gross[j] + (h === 2 || h === 3 ? ${night} / 2 : 0);
        if (h >= 17 && h < 23) v = Math.max(0, v - ${night} * 0.9 / 6);
        row[h] = v;
      } else { row[h] = imp[j]; row[24 + h] = exp[j]; }
      row[h] = +row[h].toFixed(3); row[24 + h] = +row[24 + h].toFixed(3);
    }
    days[k] = row;
  }
  const smallHours = (cons) => { let t = 0, n = 0; for (let i = 0; i < 365; i++){
    const d = new Date(Date.UTC(2026, 0, 1 + i)), k = d.toISOString().slice(5, 10);
    if (k >= '${BATTERY}'.slice(5) && k < '${PANELS}'.slice(5)) for (const h of [2, 3]){ t += cons[i * 24 + h]; n++; } } return t / n; };
  const truth = { kwh: Math.round(gross.reduce((a, b) => a + b, 0)), small: smallHours(gross) };
  Object.assign(state, { meter: { days }, _csv_imported: true, usage_input_mode: 'csv', file_when: 'sinceyes' });
  invalidate();
  const cons = withSimState({ has_solar: false, battery_kwh: 0 }, () => Array.from(sim(id).cons));
  return { truth, kwh: Math.round(cons.reduce((a, b) => a + b, 0)), small: smallHours(cons), basis: fileBasis() };
})()`;

test('a battery that charged from the grid before the panels sold anything: its nights are not the home\'s use', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, { ...HOME, battery_kwh: 9 });
  const r = await page.evaluate(withFile());
  expect(r.basis.batteryFrom, 'the battery\'s first night').toBe(BATTERY);
  expect(r.basis.rebuilt).toBe(BATTERY);
  expect(r.basis.solarFrom, 'the panels from their first sale').toBe(PANELS);
  // The small hours of those weeks are the home's, not the battery's 5 kWh an hour.
  expect(r.small, `2-4am on the battery's days: ${r.small.toFixed(2)} kWh an hour, the home's own ${r.truth.small.toFixed(2)}`).toBeLessThan(r.truth.small + 0.6);
  expect(Math.abs(r.kwh - r.truth.kwh) / r.truth.kwh, `use: ${r.kwh} kWh, really ${r.truth.kwh}`).toBeLessThan(0.08);
});

test('the same nights are left alone without a battery stated, or with a car whose charging may be in the file', async ({ page }) => {
  test.setTimeout(120_000);
  for (const extra of [{ battery_kwh: 0 }, { battery_kwh: 9, ev_active: true, ev_in_bill: true, ev_km_per_year: 15000 }]) {
    await boot(page, { ...HOME, ...extra });
    const r = await page.evaluate(withFile());
    expect(r.basis.batteryFrom, JSON.stringify(extra)).toBeUndefined();
    expect(r.basis.rebuilt, JSON.stringify(extra)).toBe(PANELS);
  }
});

test('nights far bigger than the stated battery are not taken for it', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page, { ...HOME, battery_kwh: 5 });
  const r = await page.evaluate(withFile(25));
  expect(r.basis.batteryFrom).toBeUndefined();
});

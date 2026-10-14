// @ts-check
import { test, expect } from '@playwright/test';
import { boot, esbKwFile, uploadMeterFile } from './support.js';

/*
 * Panels marked as planned, and a meter file that shows them already selling
 * from June. The app prices the home on the days before the panels and models
 * the planned ones on top, but it also paid the home for every unit the real
 * panels had sold: the same panels' sales counted twice, about €360 a year
 * off every bill on the owner's own file (14 Oct 2026). Those sales now go
 * unpaid when only the days before the panels are used.
 */
const HOME = { current_screen: 'updates', region: 'south', heating_type: 'heatpump', usage_input_mode: 'kwh', annual_kwh: 5500,
  baseline: 'BG-TOU', baseline_known: true, meter_type: 'smart', has_solar: true, solar_planned: true, considering_solar: true,
  solar_is_estimate: false, count_A: 10, azimuth_A: 157, tilt_A: 35, count_B: 0, panel_w: 460, battery_kwh: 9,
  install_cost: 10000, cost_is_manual: true, grant_eligible: false, grant_seai: 0, ev_active: false, ev_in_bill: false };

test('panels marked planned, file showing them selling: their recorded sales are not paid on top of the modelled ones', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page, HOME);
  await uploadMeterFile(page, 'HDF_kW.csv', esbKwFile('2026-10-13', 400, '2026-06-19'));
  await page.getByRole('button', { name: /Yes, use this data/ }).click();
  const r = await page.evaluate(() => {
    const W = /** @type {any} */ (window);
    const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);
    const plans = ['BG-TOU', 'EI-NB'].map((id) => {
      const plan = W.getPlanById(id), s = W.sim(id), c = W.annualCost(s, plan);
      const none = W.withSimState({ has_solar: false, count_A: 0, count_B: 0, battery_kwh: 0 }, () => W.annualCost(W.sim(id), plan));
      return { id, paid: c.export_revenue, modelled: sum(s.grid_export) * plan.export_rate, noPanels: none.export_revenue };
    });
    return { basis: W.fileBasis(), sold: W.state._csv_export_kwh, plans };
  });
  expect(r.basis.to < r.basis.start, 'the days before the panels').toBe(true);
  expect(r.sold, 'the file has the sales on it').toBeGreaterThan(1000);
  for (const p of r.plans) {
    expect(p.paid, `${p.id}: sales paid are the planned panels' own`).toBeCloseTo(p.modelled, 0);
    expect(p.noPanels, `${p.id}: no panels, no sales`).toBe(0);
  }
  expect(errors).toEqual([]);
});

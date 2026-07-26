/**
 * Bridge between app state and the pure report renderer.
 *
 * Everything that reads a global lives here; `report.ts` receives a plain
 * `ReportData` object and knows nothing about the app. That is what lets the
 * document be rendered in a test with fixed inputs.
 */

import { renderReport } from './report';
import { reportOrigin } from './theme';

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const cents = (v) => (v == null ? '' : `${(v * 100).toFixed(2)}c`);

/**
 * Switching-guide copy is authored for the web UI and contains inline markup.
 * A PDF has no HTML parser, so tags render literally — the first draft printed
 * "<b>energia.ie</b>" verbatim. Strip tags and decode the entities that
 * realistically appear in this copy.
 */
const stripHtml = (s) => String(s ?? '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Assemble the report payload from the live engine.
 *
 * @param {object} ctx everything the adapter needs, passed in rather than
 *   reached for, so the caller controls which simulation state is reported.
 */
export function buildReportData(ctx) {
  const {
    state, best, baselinePlan, baseCost, saving, annualKwh, econ,
    ranked, scenario, npvSeries, breakevenYear, regionName, usageBasis,
    switchSteps, tariffCount, verifiedDate,
  } = ctx;

  const r = best.plan.rates || {};
  const panels = (state.count_A || 0) + (state.count_B || 0);
  const kwp = (panels * (state.panel_w || 440)) / 1000;
  const hasSolar = !!state.has_solar && panels > 0;

  /** Bimonthly buckets are periods, not months — label them as such. */
  const usageByPeriod = Object.entries(state.bills || {}).map(([k, v], i) => ({
    label: `P${i + 1}`,
    value: Math.round(Number(v) || 0),
  }));

  const data = {
    generatedAt: new Date(),
    origin: reportOrigin(),
    home: {
      annualKwh: Math.round(annualKwh),
      heating: cap(state.heating_type || 'electric'),
      region: regionName || cap(state.region || 'east'),
      systemLabel: hasSolar
        ? `${kwp.toFixed(1)} kWp${state.battery_kwh > 0 ? ` + ${state.battery_kwh} kWh battery` : ''}`
        : 'No solar',
    },
    current: {
      name: `${baselinePlan.supplier} — ${baselinePlan.plan}`,
      annualCost: baseCost,
    },
    best: {
      name: `${best.plan.supplier} — ${best.plan.plan}`,
      annualCost: best.net,
      rates: [
        { label: 'Day', value: cents(r.day) },
        { label: 'Night', value: cents(r.night) },
        { label: 'Peak', value: cents(r.peak) },
        { label: 'EV', value: cents(r.ev) },
        { label: 'Export', value: cents(best.plan.export_rate) },
        { label: 'Standing', value: `€${Math.round(best.plan.standing)}/yr` },
      ].filter((x) => x.value),
    },
    savings: {
      total: saving,
      unitRate: (ctx.baseEnergy ?? 0) - (ctx.bestEnergy ?? 0),
      standing: (baselinePlan.standing || 0) - (best.plan.standing || 0),
      exportIncome: ctx.bestExport ?? 0,
    },
    ranked: (ranked || []).map((x) => ({
      name: `${x.plan.supplier} — ${x.plan.plan}`,
      cost: x.net,
    })),
    usageByPeriod,
    usageBasis: usageBasis || 'Estimated from your bill',
    switchSteps: (switchSteps || []).map((x) => ({ title: stripHtml(x.title), body: stripHtml(x.body) })),
    methodology: [
      { label: 'Tariff rates verified', value: `${verifiedDate || '—'}  ·  ${tariffCount || 0} plans compared` },
      { label: 'Usage basis', value: usageBasis || 'Estimated from your bill' },
      { label: 'Simulation', value: '8,760 hourly steps per plan across a full year' },
      { label: 'Region', value: regionName || cap(state.region || 'east') },
      { label: 'Solar finance', value: '20-year horizon · 3% discount · 0.5%/yr degradation · battery replaced at year 12' },
      { label: 'SEAI grant', value: 'Auto-calculated to the current scheme cap unless set manually' },
    ],
  };

  if (hasSolar && scenario) {
    const gross = state.install_cost || 0;
    const grant = state.grant_seai || 0;
    data.solar = {
      kwp,
      panels: `${panels} × ${state.panel_w || 440}W`,
      battery: state.battery_kwh > 0 ? `${state.battery_kwh} kWh battery` : 'No battery',
      orientation: `${state.azimuth_A ?? 180}° · ${state.tilt_A ?? 35}° tilt`,
      generated: scenario.generated || 0,
      selfConsumed: scenario.selfConsumed || 0,
      exported: scenario.exported || 0,
      gridImport: scenario.gridImport || 0,
      grossCost: gross,
      grant,
      netCost: Math.max(0, gross - grant),
      year1Saving: scenario.solarBenefit || 0,
      paybackYears: scenario.payback ?? null,
      npv20: scenario.npv20 || 0,
      cumulative: npvSeries || [],
      breakevenYear: breakevenYear ?? null,
      batteryReplacementYear: state.battery_kwh > 0 ? 12 : undefined,
    };
  }

  if (econ && econ.netSaving !== 0) {
    data.ev = {
      electricityIncrease: econ.evElectricityCost || 0,
      petrolAvoided: econ.petrolCost || 0,
      netSaving: econ.evVsPetrolNet || 0,
      km: econ.km || 0,
      fuelPrice: state.fuel_price || 1.83,
      efficiency: state.ev_kwh_per_100km || 17,
    };
  }

  return data;
}

export { renderReport };

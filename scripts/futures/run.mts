/**
 * Futures experiment: every solar + battery size for one home, priced on the
 * app's own model (src/model.js) under each tariff future in futures.json.
 *
 *   npx vite-node scripts/futures/run.mts -- --home attia --out /tmp/futures
 *
 * Writes <out>/<home>-raw.json: for each future, the home's cost on its best
 * plan with no panels, and for each system its yearly benefit, export income
 * and the plan it chose. scripts/futures/analyse.py turns that into scores.
 *
 * The model is used unchanged except for one line: simulate() treats a night
 * rate as "cheap" (worth grid-charging the battery) only when it is at or
 * below a fixed 20c. In a future where every price rises 40%, that fixed line
 * would switch grid-charging off for reasons that have nothing to do with the
 * battery, so the copy imported here scales the 20c with the future's price
 * level. Today (scale 1) the result is identical to the app. The Futures
 * module should make this a parameter instead (docs/futures-module.md, 4.5).
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const HOME_ID = arg('home', 'attia');
const OUT = resolve(arg('out', join(ROOT, 'futures-out')));

// --- the model, with the night threshold scaled (see header) ---
const src = readFileSync(join(ROOT, 'src/model.js'), 'utf8');
const needle = '(band === "night" && rate <= 0.20)';
if (!src.includes(needle)) throw new Error('simulate() night threshold not found: update run.mts to match src/model.js');
const tmp = join(ROOT, 'src/.model-futures.tmp.js');
writeFileSync(tmp, src.replace(needle, '(band === "night" && rate <= 0.20 * (globalThis.__FUTURE_PRICE_INDEX ?? 1))'));
let M: any;
try { M = await import(tmp); } finally { unlinkSync(tmp); }
const { SLP_URBAN_BIMONTHLY, SLP_RURAL_BIMONTHLY } = await import(join(ROOT, 'src/slp-2026.js'));

const FUT = JSON.parse(readFileSync(join(HERE, 'futures.json'), 'utf8'));
const HOMES = JSON.parse(readFileSync(join(HERE, 'homes.json'), 'utf8')).homes;
const home = HOMES.find((h: any) => h.id === HOME_ID);
if (!home) throw new Error(`no home "${HOME_ID}" in homes.json`);

// --- tariffs: today's file, announced price changes applied in full ---
const RAW = JSON.parse(readFileSync(join(ROOT, 'public/tariffs.json'), 'utf8'));
const PLANS = RAW.filter((t: any) => t.id && t.id !== '__meta__' && t.supplier);
function withAnnouncedChange(p: any) {
  const q = structuredClone(p); const pc = q.price_change;
  if (!pc) return q;
  const f = (b: string) => 1 + (pc.pct_bands?.[b] ?? pc.pct ?? 0);
  for (const b of Object.keys(q.rates)) if (q.rates[b] != null) q.rates[b] *= f(b);
  if (q.weekend?.rates) for (const b of Object.keys(q.weekend.rates)) q.weekend.rates[b] *= f(b);
  const sf = 1 + (pc.standing_pct ?? 0);
  for (const k of ['standing', 'standing_rural', 'standing_urban']) if (q[k] != null) q[k] *= sf;
  delete q.price_change;
  return q;
}
const TODAY = PLANS.map(withAnnouncedChange);

/** One plan as it would be priced in a future. */
export function inFuture(p: any, f: any) {
  const q = structuredClone(p);
  const scale = (band: string, r: number) => {
    let v = r * (f.imports ?? 1);
    if ((band === 'night' || band === 'ev') && f.night_ev) v *= f.night_ev;
    if (band === 'peak' && f.peak) v *= f.peak;
    return v;
  };
  for (const b of Object.keys(q.rates)) if (q.rates[b] != null) q.rates[b] = scale(b, q.rates[b]);
  const day = q.rates.day; // a cheap band never ends up dearer than the day rate
  for (const b of ['night', 'ev']) if (q.rates[b] != null && day != null) q.rates[b] = Math.min(q.rates[b], day * 0.95);
  if (q.weekend?.rates) for (const b of Object.keys(q.weekend.rates)) q.weekend.rates[b] = scale(b, q.weekend.rates[b]);
  if (f.export_to != null) q.export_rate = Math.min(q.export_rate ?? 0, f.export_to);
  if (f.export_mult != null) q.export_rate = (q.export_rate ?? 0) * f.export_mult;
  if (f.standing) { for (const k of ['standing', 'standing_rural']) if (q[k] != null) q[k] *= f.standing; delete q.standing_urban; }
  return q;
}

// --- the household ---
const KEYS = ['Jan-Feb', 'Mar-Apr', 'May-Jun', 'Jul-Aug', 'Sep-Oct', 'Nov-Dec'];
const seasonal = home.seasonal || (home.state.area === 'rural' ? SLP_RURAL_BIMONTHLY : SLP_URBAN_BIMONTHLY);
const bills: Record<string, number> = {};
KEYS.forEach((k, i) => { bills[k] = Math.max(1, Math.round(home.annual_kwh / 6 * seasonal[i])); });
const BASE = {
  onboarding_complete: true, heating_type: 'gas', hot_water_strategy: 'none', bills, usage_input_mode: 'kwh', annual_kwh: home.annual_kwh,
  region: 'east', area: 'urban', meter_type: 'smart', panel_w: 460, panel_tech: 'n_type', panel_degradation: 0.004,
  has_solar: false, count_A: 0, azimuth_A: 180, tilt_A: 30, count_B: 0, azimuth_B: 270, tilt_B: 30, inverter_kw: 5.0,
  battery_kwh: 0, battery_eff: 0.92, battery_min: 0.10, battery_max: 1.0, battery_charge_kw: 3.0, battery_discharge_kw: 5.0,
  export_enabled: true, export_limit_kw: 6.0, install_cost: 0, grant_seai: 0, grant_eligible: true, grant_is_manual: false,
  ev_active: false, ev_km_per_year: 0, ev_kwh_per_100km: 17, ev_in_bill: false, ev_charger_kw: 7, strategy_mode: 'auto', charge_from_grid: true,
  baseline: 'EI-24', chosen_plan: null, baseline_discount_pct: 0, include_dynamic: false, plan_overrides: {},
  ...home.state,
};
M.setState(BASE);

// --- the systems: one south face, inverter sized to the array (single-phase, at most 6 kW) ---
const PANELS = (arg('panels', '6,8,10,12,14,16,18,20,24,30')).split(',').map(Number);
const BATTS = (arg('batteries', '0,5,10,15,20,25')).split(',').map(Number);
const inverterFor = (kwp: number) => Math.min(6, Math.max(3.6, kwp / 1.2));
const systems: any[] = [];
for (const p of PANELS) for (const b of BATTS) systems.push({ id: `${p}-${b}`, panels: p, panel_w: 460, battery_kwh: b, inverter_kw: inverterFor(p * 0.46) });
if (home.own_system) systems.push({ id: 'own', own: true, ...home.own_system });

// --- run ---
const t0 = Date.now();
const out: any = { home: { id: home.id, label: home.label }, futures: FUT.futures, ramp_years: FUT.ramp_years, tariffs_file: 'public/tariffs.json', systems: [], states: {} };
for (const f of FUT.futures) {
  (globalThis as any).__FUTURE_PRICE_INDEX = f.imports ?? 1;
  M.setTariffs(TODAY.map((p: any) => inFuture(p, f)));
  M.invalidate();
  const none = M.withSimState({ count_A: 0, count_B: 0, battery_kwh: 0, has_solar: false }, () => {
    const b = M.getBestPlan(); return { net: b.net, plan: b.plan.id };
  });
  const rows: any = {};
  for (const s of systems) {
    const r = M.withSimState({ count_A: s.panels, count_B: 0, panel_w: s.panel_w, battery_kwh: s.battery_kwh, has_solar: true, inverter_kw: s.inverter_kw }, () => {
      const b = M.getBestPlan(); return { net: b.net, export_revenue: b.export_revenue, plan: b.plan.id };
    });
    rows[s.id] = { benefit: none.net - r.net, export_revenue: r.export_revenue, plan: r.plan };
  }
  out.states[f.id] = { no_system: none, systems: rows };
  process.stderr.write(`${f.id.padEnd(9)} ${((Date.now() - t0) / 1000).toFixed(1)}s  no panels €${none.net.toFixed(0)} on ${none.plan}\n`);
}
out.systems = systems.map((s) => {
  const kwp = s.panels * s.panel_w / 1000;
  return { ...s, kwp: +kwp.toFixed(2), gross: M.estimateInstallCost(kwp, s.battery_kwh), grant: M.calcSeaiGrant(kwp, s.battery_kwh).total };
});
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `${home.id}-raw.json`);
writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

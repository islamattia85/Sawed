/**
 * The model: the household as simulated, and everything the simulation needs.
 *
 * Moved out of main.js unchanged. Nothing here touches the page, so the same
 * code can run in a background worker (src/sim-worker.js) as well as on the
 * page. The household state, the tariff list and a few counters live here;
 * main.js changes them through the setters at the end, as an imported binding
 * cannot be assigned from outside its module.
 */
import { HOURS_IN_YEAR, DAYS_IN_MONTH, LOCATION_BASE, dayOfYear, PSO_LEVY } from './engine/constants';
import { buildHourlyGhi, buildPoa, buildPvGeneration } from './engine/solar';
import { bandAt, rateAt as engineRateAt, staticRateAt, simulateBaseline as engineSimulateBaseline, annualCost, sumF, WHOLESALE_CAP } from './engine/tariff-rules';
import { ic } from './icons';


/* ============================================================
   1. CORE CONSTANTS
   ============================================================ */

// Base location: Irish national average (Dublin lat/lon, PVGIS-aligned GHI)

// Irish regions with GHI multipliers calibrated to PVGIS county-level data.
// Variation across Ireland is real: south coast gets ~10-12% more sun than northwest.
// Ordered North → South so the selectable tiles read in the same direction as
// the map (North-West top, South Coast bottom).
export const IRISH_REGIONS = {
  northwest: {
    name: 'North-West',
    counties: 'Donegal · Sligo · Leitrim · Cavan · Monaghan',
    ghi_multiplier: 0.94,
    lat: 54.6,
    temp_offset: -1.5,
    icon: ''
  },
  west: {
    name: 'West Coast',
    counties: 'Galway · Clare · Limerick · Mayo · Roscommon',
    ghi_multiplier: 0.96,
    lat: 53.2,
    temp_offset: -0.2,
    icon: ''
  },
  east: {
    name: 'East / Dublin',
    counties: 'Dublin · Kildare · Meath · Louth',
    ghi_multiplier: 1.00,
    lat: 53.35,
    temp_offset: 0,
    icon: ''
  },
  midlands: {
    name: 'Midlands',
    counties: 'Laois · Offaly · Westmeath · Longford',
    ghi_multiplier: 0.98,
    lat: 53.4,
    temp_offset: -0.4,
    icon: ''
  },
  southeast: {
    name: 'South-East',
    counties: 'Wicklow · Carlow · Kilkenny · Tipperary',
    ghi_multiplier: 1.03,
    lat: 52.6,
    temp_offset: 0.5,
    icon: ''
  },
  south: {
    name: 'South Coast',
    counties: 'Cork · Kerry · Waterford · Wexford',
    ghi_multiplier: 1.06,
    lat: 51.9,
    temp_offset: 1.2,
    icon: ic('sun',16)
  }
};

// LOCATION is mutated by applyRegion() whenever state.region changes.
// Engine functions (buildHourlyGHI, buildPOA, buildPVGeneration) read from this directly.
export const LOCATION = {
  name: 'East / Dublin',
  lat: LOCATION_BASE.lat,
  lon: LOCATION_BASE.lon,
  ghi_kwh_m2_day: LOCATION_BASE.ghi_kwh_m2_day.slice(),
  kt: LOCATION_BASE.kt.slice(),
  temp_c: LOCATION_BASE.temp_c.slice()
};

/* ---------------------------------------------------------------
 * Adapters between the app's mutable globals and the pure engine.
 *
 * The engine functions take their inputs explicitly. These thin wrappers
 * supply the values the app happens to keep in `state`, `LOCATION` and
 * `CACHE`, so call sites are unchanged while the maths itself is testable.
 * They shrink as later phases introduce a real state boundary.
 * --------------------------------------------------------------- */

/** LOCATION mutated by applyRegion(), shaped for the engine. */
export function currentLocation(){
  return { lat: LOCATION.lat, lon: LOCATION.lon,
           ghi_kwh_m2_day: LOCATION.ghi_kwh_m2_day, kt: LOCATION.kt, temp_c: LOCATION.temp_c };
}

export function buildHourlyGHI(){
  const loc = currentLocation();
  // Scenario range (pessimist/optimist) overrides the regional multiplier.
  const o = state._ghi_override;
  if (o !== undefined && o !== null){
    const regionMult = (IRISH_REGIONS[state.region] || IRISH_REGIONS.east).ghi_multiplier || 1;
    const scale = o / regionMult;
    return buildHourlyGhi({ ...loc, ghi_kwh_m2_day: loc.ghi_kwh_m2_day.map(v => v * scale) });
  }
  return buildHourlyGhi(loc);
}

export const buildPOA = (azimuthDeg, tiltDeg, ghi) => buildPoa(azimuthDeg, tiltDeg, ghi, currentLocation());

export const buildPVGeneration = (poa, countPanels, panelW, sysLoss, inverterKw) =>
  buildPvGeneration(poa, { countPanels, panelW, sysLoss, inverterKw }, currentLocation());

/** Dynamic plans price against the cached wholesale curve. */
export const rateAt = (hour, plan, hourIdx) => engineRateAt(hour, plan, hourIdx, CACHE.wholesale);
export const simulateBaseline = (plan, cons) => engineSimulateBaseline(plan, cons, CACHE.wholesale);

export function applyRegion(regionId){
  const region = IRISH_REGIONS[regionId] || IRISH_REGIONS.east;
  LOCATION.name = region.name;
  LOCATION.lat = region.lat;
  LOCATION.lon = LOCATION_BASE.lon;
  LOCATION.ghi_kwh_m2_day = LOCATION_BASE.ghi_kwh_m2_day.map(v => v * region.ghi_multiplier);
  LOCATION.kt = LOCATION_BASE.kt.slice();
  LOCATION.temp_c = LOCATION_BASE.temp_c.map(v => v + (region.temp_offset || 0));
}

// SEMOpx day-ahead market typical profile, Ireland 2025-26 (incl VAT, pre-cap)
// Monthly mean wholesale price €/kWh — calibrated to actual market data
export const WHOLESALE_MONTHLY_BASE = [
  0.150, 0.130, 0.105, 0.085, 0.075, 0.070,   // Jan-Jun
  0.070, 0.075, 0.090, 0.110, 0.135, 0.165    // Jul-Dec
];

// Hourly multiplier on monthly mean (typical Irish SMP shape)
// Low overnight (wind keeps running), morning ramp, midday lull, big 17-19h peak.
export const WHOLESALE_HOURLY_MULT = [
  0.55, 0.50, 0.45, 0.42, 0.40, 0.45,    // 0-5am
  0.65, 0.85, 1.10, 1.05, 0.90, 0.85,    // 6-11am
  0.85, 0.80, 0.80, 0.85, 0.95, 1.35,    // 12-17h
  2.10, 1.95, 1.30, 1.00, 0.80, 0.65     // 18-23h
];
export const WHOLESALE_NEG_FLOOR = -0.10;

export let state;

/* ============================================================
   3. SOLAR PHYSICS — verbatim from main engine, adapted for
   single-roof simplified state. NOAA solar position + Erbs
   diffuse split + isotropic POA + NOCT temperature derate.
   ============================================================ */

// Erbs model — diffuse fraction from monthly clearness index

export function buildSolar(){
  const ghi = buildHourlyGHI();
  // has_solar gates generation: panel config is preserved in state so users can
  // toggle solar back on without re-entering it, but a "no solar" home must
  // simulate ZERO generation — otherwise default panel counts leak phantom
  // solar savings into no-solar results.
  const nA = state.has_solar ? (state.count_A || 0) : 0;
  const nB = state.has_solar ? (state.count_B || 0) : 0;
  // Match the engineering tool's behavior: clip per-array at the inverter limit.
  // Less accurate than combined clipping but matches the original engine.
  const poaA = buildPOA(state.azimuth_A, state.tilt_A, ghi);
  const invKw = state.inverter_kw || 5.0;
  const genA = buildPVGeneration(poaA, nA, state.panel_w, 0.86, invKw);

  // Roof B — only compute if panels present, to save cycles
  let poaB = null, genB = null;
  if (nB > 0){
    poaB = buildPOA(state.azimuth_B, state.tilt_B, ghi);
    genB = buildPVGeneration(poaB, nB, state.panel_w, 0.86, invKw);
  }

  const total = new Float32Array(HOURS_IN_YEAR);
  for (let i=0;i<HOURS_IN_YEAR;i++){
    total[i] = genA[i] + (genB ? genB[i] : 0);
  }
  return { ghi, poaA, poaB, genA, genB, total };
}

// Helper functions for total panel count and total kWp
export function totalPanels(){ return (state.count_A || 0) + (state.count_B || 0); }
export function totalKwp(){ return totalPanels() * state.panel_w / 1000; }

/* ============================================================
   4. CONSUMPTION SHAPES & BUILDER
   Heating-type-driven hourly load profiles.
   ============================================================ */
export const BIMONTHLY = [
  {key:"Jan-Feb", months:[0,1]},
  {key:"Mar-Apr", months:[2,3]},
  {key:"May-Jun", months:[4,5]},
  {key:"Jul-Aug", months:[6,7]},
  {key:"Sep-Oct", months:[8,9]},
  {key:"Nov-Dec", months:[10,11]}
];

export function bimonthlyFor(month){
  for (const b of BIMONTHLY) if (b.months.includes(month)) return b;
  return BIMONTHLY[0];
}

// Heating shape arrays — verified against real Irish load profiles.
// 24 hourly relative factors, scaled to match daily total kWh.
// Imported from solar_tool.html for engine parity.

// Heat pump: low-but-not-zero overnight (cycling), broad daytime, evening peak.
export const SHAPE_HEATPUMP_WINTER = [
  0.85,0.80,0.75,0.75,0.80,0.95, 1.15,1.40,1.30,1.05,0.90,0.85,
  0.90,0.95,1.05,1.20,1.45,1.85, 1.95,1.55,1.25,1.10,0.95,0.85
];
export const SHAPE_HEATPUMP_SUMMER = [
  0.55,0.50,0.45,0.45,0.50,0.65, 0.90,1.10,1.00,0.85,0.75,0.75,
  0.80,0.85,0.90,1.00,1.25,1.65, 1.80,1.40,1.10,0.95,0.80,0.65
];
// Gas/oil boiler house: small morning peak (kettle/toaster/shower only),
// flat low daytime when out, big sustained evening peak (oven, dryer, lights, TV).
export const SHAPE_GAS_WINTER = [
  0.25,0.22,0.22,0.22,0.25,0.35, 0.55,0.85,0.70,0.50,0.45,0.50,
  0.55,0.60,0.70,0.90,1.45,2.20, 2.45,2.10,1.65,1.15,0.70,0.40
];
export const SHAPE_GAS_SUMMER = [
  0.30,0.25,0.25,0.25,0.30,0.40, 0.60,0.85,0.70,0.50,0.45,0.45,
  0.50,0.55,0.60,0.70,1.00,1.50, 1.85,1.65,1.30,0.95,0.60,0.40
];
// Night-storage heaters (legacy NightSaver): massive 23:00-05:00 charging load.
export const SHAPE_STORAGE_WINTER = [
  2.30,2.30,2.30,2.30,2.30,2.20, 1.80,0.90,0.55,0.45,0.40,0.40,
  0.45,0.50,0.55,0.60,0.85,1.20, 1.40,1.10,0.85,0.70,1.50,2.10
];
export const SHAPE_STORAGE_SUMMER = [
  0.55,0.50,0.50,0.50,0.55,0.65, 0.95,1.20,1.00,0.75,0.65,0.65,
  0.70,0.75,0.80,0.90,1.10,1.55, 1.70,1.40,1.15,0.95,0.75,0.60
];
// Direct electric: elevated overnight base + daytime use when at home.
export const SHAPE_DIRECT_WINTER = [
  0.80,0.75,0.70,0.70,0.75,0.95, 1.30,1.55,1.25,0.95,0.85,0.85,
  0.90,0.95,1.05,1.20,1.55,2.00, 2.10,1.70,1.35,1.10,0.95,0.85
];
export const SHAPE_DIRECT_SUMMER = [
  0.40,0.35,0.35,0.35,0.40,0.55, 0.85,1.10,1.00,0.85,0.75,0.75,
  0.80,0.85,0.90,1.00,1.25,1.70, 1.85,1.45,1.15,0.95,0.75,0.55
];

// Returns the hourly shape for a given month (0-11). Matches engineering tool exactly.
// Shoulder seasons (Mar/Apr/Sep/Oct) average winter + summer for smooth transition.
// Hot water strategy shifts ~15% of daily load between morning/evening peaks (legacy)
// and the 2-5am window (smart). Optional 4-bucket user override reshapes the curve.
export function getShape(month){
  // 1) Base shape by heating type — with shoulder season averaging
  const heatingType = state.heating_type || 'gas';
  const isWinter = [10,11,0,1,2].includes(month);
  const isSummer = [5,6,7].includes(month);

  function pickShape(winterArr, summerArr){
    if (isWinter) return [...winterArr];
    if (isSummer) return [...summerArr];
    return winterArr.map((v,i) => (v + summerArr[i]) / 2);  // shoulder = average
  }

  let base;
  switch (heatingType){
    case "heatpump":
      base = pickShape(SHAPE_HEATPUMP_WINTER, SHAPE_HEATPUMP_SUMMER); break;
    case "storage":
      base = pickShape(SHAPE_STORAGE_WINTER, SHAPE_STORAGE_SUMMER); break;
    case "direct":
      base = pickShape(SHAPE_DIRECT_WINTER, SHAPE_DIRECT_SUMMER); break;
    case "gas":
    case "oil":
    case "none":
    default:
      base = pickShape(SHAPE_GAS_WINTER, SHAPE_GAS_SUMMER); break;
  }

  // 2) Hot water strategy
  // - "smart" shifts 15% of daily load from morning/evening peaks → 2-5am
  // - "legacy" boosts evening peaks 10% (immersion on timer at peak times)
  // - "none" no change
  if (state.hot_water_strategy === "smart"){
    const baseSum = base.reduce((a,b)=>a+b, 0);
    const shiftFrac = 0.15;
    const shiftAmount = baseSum * shiftFrac;
    const removeHours = [7, 8, 17, 18, 19];
    const addHours = [2, 3, 4];
    const perRemove = shiftAmount / removeHours.length;
    const perAdd = shiftAmount / addHours.length;
    for (const h of removeHours) base[h] = Math.max(0.30, base[h] - perRemove);
    for (const h of addHours) base[h] += perAdd;
  } else if (state.hot_water_strategy === "legacy"){
    const peakHours = [7, 8, 17, 18, 19];
    for (const h of peakHours) base[h] *= 1.10;
  }

  // 3) Legacy `ev` flag (the actual EV kWh is layered on separately in buildConsumption)
  if (state.ev){
    const evHours = [2, 3, 4, 5];
    const baseSum = base.reduce((a,b)=>a+b, 0);
    const evBump = baseSum * 0.25;
    const perEvHour = evBump / evHours.length;
    for (const h of evHours) base[h] += perEvHour;
  }

  // 4) User override: 4-bucket reshaping from advanced consumption editor
  const buckets = state._shape_buckets;
  if (buckets){
    const sum = (buckets.night||0) + (buckets.morning||0) + (buckets.day||0) + (buckets.evening||0);
    if (sum >= 90 && sum <= 110){
      const bucketHours = {
        night:   [22,23,0,1,2,3,4,5],
        morning: [6,7,8,9],
        day:     [10,11,12,13,14,15,16],
        evening: [17,18,19,20,21]
      };
      const newBase = new Array(24).fill(0);
      Object.entries(bucketHours).forEach(([k, hrs]) => {
        const pct = (buckets[k] || 0) / sum;
        const perHour = pct / hrs.length;
        hrs.forEach(h => { newBase[h] = perHour * 24; });
      });
      return newBase;
    }
  }

  return base;
}

/* ------------------------------------------------------------
   buildConsumption — matches engineering tool's algorithm:
   - Uses bimonthlyFor() for precise month → bimonth mapping
   - Weekend factor (1.08 vs 0.985 weekday)
   - Rebalance step to ensure annual total = sum of bills exactly
   - EV smearing: 2-5am up to charger limit, overflow to 6-10am
   ------------------------------------------------------------ */
export function buildConsumption(){
  // Build "without EV" array first (the user's CURRENT actual usage from bills)
  const consNoEv = new Float32Array(HOURS_IN_YEAR);
  let hourIdx = 0;

  // If user imported a smart meter CSV, we have a real 24-hour load shape.
  // Blend it 70/30 with the heating-type shape so seasonal variation is preserved.
  const csvShape = state._csv_hourly_shape;  // 24-element normalized array or null

  for (let m=0; m<12; m++){
    const bi = bimonthlyFor(m);
    // Days in this month / total days in this bimonth = month's share of bimonth
    const monthShare = DAYS_IN_MONTH[m] / (DAYS_IN_MONTH[bi.months[0]] + DAYS_IN_MONTH[bi.months[1]]);
    const monthKwh = (state.bills[bi.key] || 0) * monthShare;
    const dailyKwh = monthKwh / DAYS_IN_MONTH[m];
    const heatingShape = getShape(m);
    const heatingSum = heatingShape.reduce((a,b)=>a+b, 0);

    // Merge: if CSV shape available, blend 70% CSV + 30% heating-type
    let shape, shapeSum;
    if (csvShape && csvShape.length === 24){
      shape = new Array(24);
      const csvSum = csvShape.reduce((a,b)=>a+b, 0);
      for (let h=0; h<24; h++){
        const csvFrac   = csvShape[h]   / csvSum;
        const heatFrac  = heatingShape[h] / heatingSum;
        shape[h] = 0.70 * csvFrac + 0.30 * heatFrac;
      }
      shapeSum = shape.reduce((a,b)=>a+b, 0);
    } else {
      shape = heatingShape;
      shapeSum = heatingSum;
    }

    for (let d=0; d<DAYS_IN_MONTH[m]; d++){
      // Day-of-week — 1 Jan 2025 was Wed (day 3 from Sunday=0). dow = (doy + 4) % 7
      const dow = (dayOfYear(m,d+1) + 4) % 7;
      const weekendFactor = (dow >= 5) ? 1.08 : 0.985;  // weekends consume ~10% more
      for (let h=0; h<24; h++){
        const frac = shape[h] / shapeSum;
        consNoEv[hourIdx++] = dailyKwh * frac * weekendFactor;
      }
    }
  }
  // Rebalance to exact annual total from bills (handles rounding + weekend factor drift)
  const total = consNoEv.reduce((a,b)=>a+b, 0);
  const targetTotal = Object.values(state.bills).reduce((a,b)=>a+b, 0);
  if (total > 0){
    const k = targetTotal / total;
    for (let i=0;i<HOURS_IN_YEAR;i++) consNoEv[i] *= k;
  }

  // EV-in-bill carve-out: if the user's entered bill already includes their EV
  // charging (they own the car today), the bill-implied kWh contains the car —
  // remove its kWh from the base household load before (re)adding it as a
  // shaped night load. Without this the car is counted twice.
  const evConfKwh = (+state.ev_km_per_year || 0) * (+state.ev_kwh_per_100km || 17) / 100;
  if (state.ev_in_bill && evConfKwh > 0){
    let _tot = 0; for (let i=0;i<HOURS_IN_YEAR;i++) _tot += consNoEv[i];
    const _f = _tot > 0 ? Math.max(0.25, (_tot - evConfKwh) / _tot) : 1;
    for (let i=0;i<HOURS_IN_YEAR;i++) consNoEv[i] *= _f;
  }

  // Build "with EV" array
  const cons = new Float32Array(HOURS_IN_YEAR);
  for (let i=0;i<HOURS_IN_YEAR;i++) cons[i] = consNoEv[i];

  const evKmPerYear = state.ev_active ? (+state.ev_km_per_year || 0) : 0;
  const evKwhPer100 = +state.ev_kwh_per_100km || 17;
  const evAnnual = evKmPerYear * evKwhPer100 / 100;
  if (evAnnual > 0){
    const chargerKw = +state.ev_charger_kw || 7;
    const dailyEvKwh = evAnnual / 365;
    const nightCapacityKwh = chargerKw * 3;
    const nightKwh = Math.min(dailyEvKwh, nightCapacityKwh);
    const overflowKwh = Math.max(0, dailyEvKwh - nightCapacityKwh);
    const nightPerHour = nightKwh / 3;
    const dayPerHour = overflowKwh / 4;
    for (let i=0; i<HOURS_IN_YEAR; i++){
      const h = i % 24;
      if (h >= 2 && h < 5) cons[i] += nightPerHour;
      else if (h >= 6 && h < 10 && overflowKwh > 0) cons[i] += dayPerHour;
    }
  }
  return { cons, consNoEv };
}

/* ============================================================
   5. WHOLESALE — synthetic SEMOpx-tracking curve with NEGATIVE
   prices permitted (dynamic-tariff customers paid to consume
   during wind-surplus periods). Floor at -€0.10/kWh.
   ============================================================ */
export function buildWholesale(){
  const prices = new Float32Array(HOURS_IN_YEAR);
  let h = 0;
  for (let m=0; m<12; m++){
    const monthBase = WHOLESALE_MONTHLY_BASE[m];
    for (let d=0; d<DAYS_IN_MONTH[m]; d++){
      // Deterministic daily variance (no random noise — results are stable)
      const dailyVar = 0.78 + 0.44 * Math.sin(d * 2.347 + m * 1.831 + 0.5);
      for (let hr=0; hr<24; hr++){
        let p = monthBase * WHOLESALE_HOURLY_MULT[hr] * dailyVar;
        if (p > WHOLESALE_CAP) p = WHOLESALE_CAP;
        if (p < WHOLESALE_NEG_FLOOR) p = WHOLESALE_NEG_FLOOR;
        prices[h++] = p;
      }
    }
  }
  return prices;
}

/* ============================================================
   6. TARIFF REGISTRY
   Curated subset of Irish residential plans (verified incl-VAT,
   June 2026). Includes one dynamic-tariff plan per CRU mandate.
   ============================================================ */
export const EMBEDDED_TARIFFS = [
  {"id": "EI-24", "supplier": "Electric Ireland", "plan": "Home Electric+ Saver 16%", "type": "flat", "rates": {"day": 0.313, "night": 0.313, "peak": 0.313, "ev": 0.313}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Saver 16%", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03", "welcome": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Saver 16%"]}}, "notes": "Smart meter, 24-hour rate, 16% off unit rates for 12 months, new customers. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "welcome_credit": 30.0},
  {"id": "EI-SST", "supplier": "Electric Ireland", "plan": "Home Electric + SST Saver 16%", "type": "tou", "rates": {"day": 0.3405, "night": 0.1789, "peak": 0.3633, "ev": 0.1789}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric + SST Saver 16%", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00", "peak": "Peak: 17.00 - 19.00"}, "also": ["Home Electric SST Saver 16%"], "read": "2026-10-03"}, "notes": "Smart meter day/night/peak, 16% off unit rates for 12 months, new customers. Also listed, at the same rates, as 'Home Electric SST Saver 16%'. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-NB", "supplier": "Electric Ireland", "plan": "Home Electric+ Night Boost", "type": "ev", "rates": {"day": 0.376, "night": 0.1854, "ev": 0.1088}, "windows": {"night": [23, 8], "ev": [2, 4]}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Night Boost", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00", "ev": "Night Boost: 02.00 - 04.00"}, "read": "2026-10-03"}, "notes": "Smart meter; Night Boost 02:00-04:00, 5.5% off unit rates, new customers. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-NS", "supplier": "Electric Ireland", "plan": "Energysaver Nightsaver 16%", "type": "tou", "rates": {"day": 0.3412, "night": 0.1683}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 328.58, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver Nightsaver 16%", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00"}, "read": "2026-10-03", "welcome": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver Nightsaver 16%"]}}, "notes": "Day & night (non-smart) meter, 16% off for 12 months. Nightsaver urban standing €328.58 not printed on the card; carried from the last full price list. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "welcome_credit": 20.0},
  {"id": "EI-ES", "supplier": "Electric Ireland", "plan": "Energysaver 16%", "type": "flat", "rates": {"day": 0.3195, "night": 0.3195, "peak": 0.3195, "ev": 0.3195}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver 16%", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03", "welcome": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Energysaver 16%"]}}, "notes": "Standard (non-smart) 24-hour meter, 16% off unit rates for 12 months, new customers. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "welcome_credit": 20.0},
  {"id": "EI-GREEN", "supplier": "Electric Ireland", "plan": "Green Electricity", "type": "flat", "rates": {"day": 0.3613, "night": 0.3613, "peak": 0.3613, "ev": 0.3613}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Green Electricity", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03"}, "notes": "Standard meter, 100% green electricity, 5.5% off unit rates. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-GREEN-NS", "supplier": "Electric Ireland", "plan": "Green Electricity NightSaver", "type": "tou", "rates": {"day": 0.3862, "night": 0.1915}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 328.58, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Green Electricity NightSaver", "Pricing"], "fields": {"day": "Day: 08.00 - 23.00", "night": "Night: 23.00 - 08.00"}, "read": "2026-10-03"}, "notes": "Day & night meter, 100% green electricity, 5.5% off. Nightsaver standing carried from the last full price list. Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check."},
  {"id": "EI-WKND", "supplier": "Electric Ireland", "plan": "Home Electric+ Weekender", "type": "flat", "rates": {"day": 0.3865, "night": 0.3865, "peak": 0.3865, "ev": 0.3865}, "windows": {"ev": null}, "standing": 250.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.electricireland.ie/switch/new-customer/price-plans?priceType=E", "anchor": ["Home Electric+ Weekender", "Pricing"], "fields": {"day": "Electricity unit price"}, "read": "2026-10-03"}, "notes": "Smart meter, one flat rate, and free electricity 08:00-23:00 on Saturday or Sunday (the customer picks; modelled as Saturday). Urban standing charge €250.77 inc VAT: Electric Ireland's plan cards do not print it; it is consistent with each card's Estimated Annual Bill (4,200 kWh + standing + €19.10 PSO). CEG 19.5c not re-read from electricireland.ie in this check.", "weekend": {"days": [5], "window": [8, 23], "rates": {"day": 0, "night": 0, "peak": 0, "ev": 0}}},
  {"id": "EI-DYN", "supplier": "Electric Ireland", "plan": "Dynamic Price Plan", "type": "dynamic", "rates": {"day": 0.1981, "night": 0.0852, "peak": 0.2255, "ev": 0.0852}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 328.58, "exit": 50, "length": 12, "green": false, "export_rate": 0.195, "verified_date": "2026-06-02", "notes": "Not in Electric Ireland's new-customer plan list on 30 Sep 2026, and its rates are not published there; held back rather than shown with unconfirmed figures.", "discontinued": true},
  {"id": "BG-24", "supplier": "Bord Gáis Energy", "plan": "Smart All Day Electricity Discount", "type": "flat", "rates": {"day": 0.2995, "night": 0.2995, "peak": 0.2995, "ev": 0.2995}, "windows": {"ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart All Day Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day"}, "read": "2026-10-03"}, "notes": "Smart meter, one flat rate, 26% off unit rates for 12 months. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-TOU", "supplier": "Bord Gáis Energy", "plan": "Smart Standard Electricity Discount", "type": "tou", "rates": {"day": 0.32, "night": 0.2362, "peak": 0.3896, "ev": 0.2362}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Standard Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night"}, "read": "2026-10-03"}, "notes": "Smart day/night/peak, 26% off for 12 months. Peak 17:00-19:00 Monday to Friday only. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"days": [5, 6], "rates": {"peak": 0.32}, "same_as": {"peak": "day"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-TOU-PLUS", "supplier": "Bord Gáis Energy", "plan": "Smart Standard Plus Electricity Discount", "type": "tou", "rates": {"day": 0.32, "night": 0.2362, "peak": 0.3896, "ev": 0.2362}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Standard Plus Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night"}, "read": "2026-10-03"}, "notes": "Same rates as Smart Standard with the Spend Goal feature. Peak Monday to Friday only. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"days": [5, 6], "rates": {"peak": 0.32}, "same_as": {"peak": "day"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-EV", "supplier": "Bord Gáis Energy", "plan": "Smart EV Plus Electricity Discount", "type": "ev", "rates": {"day": 0.32, "night": 0.2419, "peak": 0.4083, "ev": 0.1252}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": [2, 5]}, "standing": 364.89, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart EV Plus Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night", "ev": "EV"}, "read": "2026-10-03"}, "notes": "Smart EV plan, 15% off for 12 months; EV time 02:00-05:00 every day, peak Monday to Friday (Smart EV tariff terms, Aug 2026). UNVERIFIED standing: €364.89 is the Smart EV plan's standing charge; the EV Plus card does not print one. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"days": [5, 6], "rates": {"peak": 0.32}, "same_as": {"peak": "day"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-WKND", "supplier": "Bord Gáis Energy", "plan": "Smart Weekend Electricity Discount", "type": "tou", "rates": {"day": 0.3152, "night": 0.2818, "peak": 0.3845, "ev": 0.2818}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.77, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Weekend Electricity Discount", "Discounted electricity unit rates"], "fields": {"day": "Day", "peak": "Peak", "night": "Night"}, "read": "2026-10-03"}, "notes": "Smart plan charged at the night rate all weekend, Friday 11pm to Monday 8am; 26% off for 12 months. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "weekend": {"span": [[4, 23], [0, 8]], "rates": {"day": 0.2818, "peak": 0.2818}, "same_as": {"day": "night", "peak": "night"}}, "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-STANDARD-VARIABLE-SMART-ALL-DAY-ELECTRICITY", "supplier": "Bord Gáis Energy", "plan": "Standard Variable Smart All Day Electricity", "type": "flat", "rates": {"day": 0.4159, "night": 0.4159, "peak": 0.4159, "ev": 0.4159}, "windows": {"ev": null}, "standing": 244.77, "exit": 0, "length": 0, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Standard Variable Smart All Day Electricity", "Electricity unit rates"], "fields": {"day": "Day"}, "read": "2026-10-03"}, "notes": "No discount, no fixed term. Standing €244.77 inc VAT urban (bordgaisenergy.ie/home/our-tariffs), rising to €262.38 on 9 Oct 2026. Microgen export 18.5c (bordgaisenergy.ie/home/microgeneration).", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "bordgaisenergy.ie/home/price-change-info and our-tariffs (new standard tables)", "note": "Bord Gáis unit rates +9.1%, standing +7.2% from 9 Oct 2026 (24hr standard 41.59c → 45.38c, standing €244.77 → €262.38)."}},
  {"id": "BG-DYN", "supplier": "Bord Gáis", "plan": "Smart Dynamic", "type": "dynamic", "rates": {"day": 0.1673, "night": 0.1673, "peak": 0.1673, "ev": 0.1673}, "windows": {"ev": null}, "standing": 331.96, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "notes": "★ NEW (1 June 2026). Single base rate 16.73c + half-hourly wholesale. No discount on base. Day-ahead prices at bordgaisenergy.ie/day-ahead-market-prices. UNVERIFIED since launch — the base rate is not published on the plan-comparison page and was not re-checked on 25 Aug 2026.", "source": {"url": "https://www.bordgaisenergy.ie/home/our-plans?isNewCustomer=YES&fuelType=ELECTRICITY&smartMeter=SMARTMETER_YES&isSmartMeter=true", "anchor": ["Smart Dynamic Electricity", "Electricity unit rates"], "fields": {"day": "Base"}, "read": "2026-10-03"}, "price_change": {"effective_date": "2026-10-09", "pct": 0.137, "standing_pct": 0.047, "direction": "increase", "source": "bordgaisenergy.ie/home/our-tariffs, Smart Dynamic table from 9 Oct 2026", "note": "Base rate 16.73c → 19.02c and standing €331.96 → €347.56 from 9 Oct 2026; the wholesale part is added hourly on top."}},
  {"id": "EN-SMART-24-HOUR", "supplier": "Energia", "plan": "Smart 24 Hour", "type": "flat", "rates": {"day": 0.281, "night": 0.281, "peak": 0.281, "ev": 0.281}, "windows": {"ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Smart 24 Hour"], "fields": {"day": "Smart meter"}, "read": "2026-10-03"}, "notes": "Smart meter flat rate, 30% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0.04, "note": "28.10c → 29.22c from 12 Oct 2026."}},
  {"id": "EN-SMART", "supplier": "Energia", "plan": "Smart Data", "type": "tou", "rates": {"day": 0.3075, "night": 0.1691, "peak": 0.3454, "ev": 0.1691}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Smart Data"], "fields": {"night": {"label": "Smart meter", "col": 1}, "day": {"label": "Smart meter", "col": 2}, "peak": {"label": "Smart meter", "col": 3}}, "read": "2026-10-03"}, "notes": "Smart day/night/peak, 27% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0.03, "pct_bands": {"day": 0.03, "night": 0.28, "peak": 0.05, "ev": 0.28}, "note": "From 12 Oct 2026: day 30.75 → 31.68c, night 16.91 → 21.64c, peak 34.54 → 36.26c."}},
  {"id": "EN-SMART-DAY-NIGHT", "supplier": "Energia", "plan": "Smart Day/Night", "type": "tou", "rates": {"day": 0.3519, "night": 0.1734, "ev": 0.1734}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Smart Day/Night"], "fields": {"night": {"label": "Smart meter", "col": 1}, "day": {"label": "Smart meter", "col": 2}}, "read": "2026-10-03"}, "notes": "Smart day/night, no peak band, 20% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0, "pct_bands": {"day": 0, "night": 0.25, "ev": 0.25}, "note": "From 12 Oct 2026: night 17.34 → 21.67c, day unchanged."}},
  {"id": "EN-EV", "supplier": "Energia", "plan": "EV Smart Drive", "type": "ev", "rates": {"day": 0.4016, "night": 0.4016, "peak": 0.4016, "ev": 0.0942}, "windows": {"ev": [2, 6], "peak": null, "night": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "EV Smart Drive"], "fields": {"ev": {"label": "Smart meter", "col": 1}, "day": {"label": "Smart meter", "col": 2}}, "read": "2026-10-03"}, "notes": "Smart EV, charge window 02:00-06:00, 10% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0, "pct_bands": {"ev": 0.3}, "note": "From 12 Oct 2026: EV charge 9.42 → 12.25c, other hours unchanged."}},
  {"id": "EN-24", "supplier": "Energia", "plan": "Standard Electricity", "type": "flat", "rates": {"day": 0.2986, "night": 0.2986, "peak": 0.2986, "ev": 0.2986}, "windows": {"ev": null}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.energia.ie/energy-plans/electricity", "anchor": ["Energy Plans Table", "Standard Electricity"], "fields": {"day": "Standard 24hr meter"}, "read": "2026-10-03"}, "notes": "Standard (non-smart) 24-hour meter, 30% off. Rates inc VAT from Energia's plan table, valid to 11 Oct 2026. Standing €265.01 inc VAT urban (€255.29 ex VAT +5% from 12 Oct = €278.27 inc). CEG 18.5c.", "price_change": {"effective_date": "2026-10-12", "standing_pct": 0.05, "direction": "increase", "source": "energia.ie/about-energia/our-tariffs, standard rates from 12 Oct 2026 (ex VAT) with this plan's discount", "pct": 0.02, "note": "29.86c → 30.45c from 12 Oct 2026."}},
  {"id": "EN-DYN", "supplier": "Energia", "plan": "Dynamic Rates", "type": "dynamic", "rates": {"day": 0.2197, "night": 0.1251, "peak": 0.2292, "ev": 0.1251}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 299.75, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "notes": "Smart Track: base rates inc VAT from energia.ie/about-energia/our-tariffs (rates from 2 June 2026), plus the half-hourly wholesale price. Standing €299.75 urban.", "source": {"url": "https://www.energia.ie/about-energia/our-tariffs", "anchor": ["Dynamic Base Unit Rate Prices"], "fields": {"day": "Dynamic Day Base Unit Rate", "night": "Dynamic Night Base Unit Rate", "peak": "Dynamic Peak Base Unit Rate"}, "col": 1, "read": "2026-10-03"}},
  {"id": "EN-EV-PLUS", "supplier": "Energia", "plan": "EV Smart Drive Plus", "type": "ev", "rates": {"day": 0.3893, "night": 0.2399, "peak": 0.5108, "ev": 0.1103}, "windows": {"ev": [2, 6], "peak": [17, 19], "night": [23, 8]}, "standing": 265.01, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-06-02", "notes": "Not in Energia's new-customer plan table on 30 Sep 2026; still on its tariff list for existing customers.", "price_change": {"effective_date": "2026-10-12", "pct": 0.0, "pct_bands": {"day": 0.0, "night": 0.0, "peak": 0.0, "ev": 0.201}, "standing_pct": 0.28, "direction": "increase", "source": "Energia published tariff list effective 12 Oct 2026 (https://www.energia.ie/about-energia/our-tariffs)", "note": "Energia EV Smart Drive Plus from 12 Oct 2026: EV-window rate +20%, day/night/peak unchanged, standing charge +28%. From Energia's published price list."}, "discontinued": true},
  {"id": "SSE-EVDAY", "supplier": "SSE Airtricity", "plan": "Smart Everyday 30%", "type": "flat", "rates": {"day": 0.2879, "night": 0.2879, "peak": 0.2879, "ev": 0.2879}, "windows": {"ev": null}, "standing": 263.86, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/smart-everyday-electricity-with-top-discount", "anchor": ["Our electricity prices"], "fields": {"day": "24hr meter", "standing": "Urban 24hr meter"}, "col": 1, "read": "2026-10-03"}, "notes": "Smart meter flat rate, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check."},
  {"id": "SSE-DNP", "supplier": "SSE Airtricity", "plan": "Smart Day/Night/Peak 30%", "type": "tou", "rates": {"day": 0.3047, "night": 0.1958, "peak": 0.3412, "ev": 0.1958}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 263.86, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/smart-day-night-peak-electricity-with-top-discount", "anchor": ["Our electricity prices", "Electricity - Smart Meter"], "fields": {"day": "Smart Day", "night": "Smart Night", "peak": "Smart Peak", "standing": "Urban Smart"}, "col": 1, "read": "2026-10-03"}, "notes": "Smart day/night/peak, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check."},
  {"id": "SSE-24", "supplier": "SSE Airtricity", "plan": "Home Electricity 30% (24hr)", "type": "flat", "rates": {"day": 0.2879, "night": 0.2879, "peak": 0.2879, "ev": 0.2879}, "windows": {"ev": null}, "standing": 263.86, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/electricity-top-discount", "anchor": ["Our electricity prices"], "fields": {"day": "24hr meter", "standing": "Urban 24hr"}, "col": 1, "read": "2026-10-03", "welcome": {"url": "https://www.sseairtricity.com/ie/home/help-centre/our-tariffs", "anchor": ["1 Year Electricity 30% plus"], "in": "html", "chars": 40}}, "notes": "Standard 24-hour meter, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check.", "welcome_credit": 125.0},
  {"id": "SSE-NS", "supplier": "SSE Airtricity", "plan": "Home Electricity 30% (Nightsaver)", "type": "tou", "rates": {"day": 0.2917, "night": 0.1866}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 338.98, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/electricity-top-discount", "anchor": ["Our electricity prices"], "fields": {"day": "Night Saver meter (Day)", "night": "Night Saver meter (Night)", "standing": "Urban Night saver"}, "col": 1, "read": "2026-10-03", "welcome": {"url": "https://www.sseairtricity.com/ie/home/help-centre/our-tariffs", "anchor": ["1 Year Electricity 30% plus"], "in": "html", "chars": 40}}, "notes": "Day & night meter, 30% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check.", "welcome_credit": 125.0},
  {"id": "SSE-EVMAX", "supplier": "SSE Airtricity", "plan": "Smart EV Max", "type": "ev", "rates": {"day": 0.3858, "night": 0.3858, "peak": 0.3858, "ev": 0.1386}, "windows": {"ev": [23, 5], "peak": null, "night": null}, "standing": 357.23, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/electricity-smart-ev-max", "anchor": ["Our electricity prices"], "fields": {"day": "Smart EV Max 18 Hour", "ev": "Smart EV Max 6 Hour", "standing": "Urban Smart EV"}, "col": 1, "read": "2026-10-03"}, "notes": "Smart EV: 6 cheap hours 23:00-05:00, 20% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check."},
  {"id": "SSE-WKND", "supplier": "SSE Airtricity", "plan": "Smart Weekends", "type": "tou", "rates": {"day": 0.4033, "night": 0.2595, "peak": 0.4519, "ev": 0.2595}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 356.2, "exit": 50, "length": 12, "green": true, "export_rate": 0.195, "verified_date": "2026-10-03", "source": {"url": "https://www.sseairtricity.com/ie/home/products/smart-weekends-electricity", "anchor": ["Our electricity prices"], "fields": {"day": "Weekday Day", "night": "Weekday Night", "peak": "Weekday Peak", "weekend.day": "Weekend Day", "weekend.night": "Weekend Night", "weekend.peak": "Weekend Peak", "standing": "Urban Smart"}, "col": 1, "read": "2026-10-03"}, "notes": "Half-price electricity from 8am Saturday to 11pm Sunday; 15% off for 12 months. Discounted rates and standing from the plan page, inc VAT. CEG 19.5c not re-read from sseairtricity.com in this check.", "weekend": {"span": [[5, 8], [6, 23]], "rates": {"day": 0.2017, "night": 0.1296, "peak": 0.2257}}},
  {"id": "YN-24", "supplier": "Yuno Energy", "plan": "Electricity Bonus 24hr", "type": "flat", "rates": {"day": 0.3485, "night": 0.3485, "peak": 0.3485, "ev": 0.3485}, "windows": {"ev": null}, "standing": 219.22, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus", "24hr Urban"], "fields": {"day": "24Hr Unit Rate", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03", "welcome": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus"], "within": 6}}, "notes": "24-hour meter, 12-month plan. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page).", "welcome_credit": 50.0},
  {"id": "YN-DN", "supplier": "Yuno Energy", "plan": "Electricity Bonus Day/Night", "type": "tou", "rates": {"day": 0.3812, "night": 0.2303}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 247.94, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus", "Day Night Urban"], "fields": {"day": "Day Unit Rate", "night": "Night Unit Rate", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03", "welcome": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Bonus"], "within": 6}}, "notes": "Day & night meter. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page).", "welcome_credit": 50.0},
  {"id": "YN-DNP", "supplier": "Yuno Energy", "plan": "Electricity Smart Bonus", "type": "tou", "rates": {"day": 0.3756, "night": 0.2298, "peak": 0.4076, "ev": 0.2298}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 235.77, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["Electricity Smart Bonus", "Electricity Pricing", "Urban"], "fields": {"day": "Day Unit Rate", "night": "Night Unit Rate", "peak": "Peak Unit Rate", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03"}, "notes": "Smart day/night/peak (day 08-23, night 23-08, peak 17-19). Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page)."},
  {"id": "YN-EV", "supplier": "Yuno Energy", "plan": "EV Variable", "type": "ev", "rates": {"day": 0.367, "night": 0.367, "peak": 0.367, "ev": 0.1211}, "windows": {"ev": [2, 6], "peak": null, "night": null}, "standing": 334.19, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["EV Variable", "24hr Urban"], "fields": {"day": "24Hr Unit Rate", "ev": "EV 2am - 6am", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03"}, "notes": "24-hour rate with a 02:00-06:00 EV rate. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page)."},
  {"id": "YN-EV-DNP", "supplier": "Yuno Energy", "plan": "EV Variable Smart", "type": "ev", "rates": {"day": 0.4047, "night": 0.2146, "peak": 0.4538, "ev": 0.0859}, "windows": {"ev": [2, 6], "peak": [17, 19], "night": [23, 8]}, "standing": 358.07, "exit": 50, "length": 12, "green": false, "export_rate": 0.1716, "verified_date": "2026-10-03", "source": {"url": "https://www.yunoenergy.ie/", "anchor": ["EV Variable Smart", "DNP Urban"], "fields": {"day": "Day Unit Rate", "night": "Night Unit Rate", "peak": "Peak Unit Rate", "ev": "EV 2am - 6am", "standing": "Urban Standing Charge"}, "col": 2, "read": "2026-10-03"}, "notes": "Smart day/night/peak with a 02:00-06:00 EV rate. Yuno homepage price tables, 'Discount Tariff Details Valid from 14th September 2026', urban, inc VAT; standing excludes the PSO levy, which Yuno lists separately. Clean export 17.16c (same page)."},
  {"id": "FL-24", "supplier": "Flogas", "plan": "Smart 24hr 29%", "type": "flat", "rates": {"day": 0.2931, "night": 0.2931, "peak": 0.2931, "ev": 0.2931}, "windows": {"ev": null}, "standing": 300.2, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Smart 24Hr Electricity 29% Loyalty Discount", "fields": {"day": "24 hr unit rate", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": " Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "FL-DNP", "supplier": "Flogas", "plan": "Smart Day/Night/Peak 29%", "type": "tou", "rates": {"day": 0.3194, "night": 0.2305, "peak": 0.3779, "ev": 0.2305}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 300.2, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Smart Electricity 29% Loyalty Discount", "fields": {"day": "day - 08:00", "night": "night - 23:00", "peak": "peak - 17:00", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": " Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "FL-EV", "supplier": "Flogas", "plan": "Smart EV Night Charge 29%", "type": "ev", "rates": {"day": 0.3176, "night": 0.2466, "peak": 0.4095, "ev": 0.0996}, "windows": {"ev": [2, 5], "peak": [17, 19], "night": [23, 8]}, "standing": 387.16, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Smart EV Night Charge 29% Electricity Loyalty Discount", "fields": {"day": "day - 08:00", "night": "night - 23:00", "peak": "peak - 17:00", "ev": "ev night charge - 02:00", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": "EV Night Charge 02:00-05:00. Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "FL-STD-24", "supplier": "Flogas", "plan": "Electricity 28% (24hr)", "type": "flat", "rates": {"day": 0.3168, "night": 0.3168, "peak": 0.3168, "ev": 0.3168}, "windows": {"ev": null}, "standing": 305.68, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-10-03", "source": {"url": "https://www.flogas.ie/price-plans/?newCustomer=Yes&lookingFor=Electricity&meterType=Smart", "api": "flogas", "plan": "Electricity 28% Loyalty Discount", "fields": {"day": "unit rate", "standing": "standing charge"}, "read": "2026-10-03"}, "notes": "Standard (non-smart) 24-hour meter. Flogas pricing API (webapi-prd.flogas.ie, the data behind flogas.ie/price-plans), new-customer offer, prices from 20 Jul 2026, urban, inc VAT; standing excludes the €19.10 PSO. Microgen export 18.5c (flogas.ie). Exit fee €50."},
  {"id": "PIN-LF", "supplier": "Pinergy", "plan": "Lifestyle Standard Smart Tariff", "type": "tou", "rates": {"day": 0.458, "night": 0.3484, "peak": 0.4904, "ev": 0.3484}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "verified_date": "2026-10-03", "source": {"url": "https://www.pinergy.ie/terms-conditions/tariffs/", "anchor": ["Standard Smart Tariff"], "fields": {"day": "Day Unit Price", "night": "Night Unit Price", "peak": "Peak Unit Price", "standing": {"label": "Standing Charge", "col": 4}}, "col": 2, "read": "2026-10-03"}, "notes": " Pinergy 'Lifestyle & Smart Tariffs', correct as at 14 Sep 2026, inc VAT; standing €283.47 excludes the €19.10 PSO. Export 25c not re-read in this check."},
  {"id": "PIN-WFH", "supplier": "Pinergy", "plan": "Lifestyle Working from Home Time", "type": "tou", "rates": {"day": 0.458, "wfh": 0.3206, "night": 0.458, "peak": 0.458, "ev": 0.458}, "windows": {"peak": null, "night": null, "ev": null, "wfh": [9, 17]}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "verified_date": "2026-10-03", "source": {"url": "https://www.pinergy.ie/terms-conditions/tariffs/", "anchor": ["Working from Home Time"], "fields": {"wfh": "Unit Price 9am to 5pm Weekdays", "day": "Unit Price All other times", "standing": {"label": "Standing Charge", "col": 4}}, "col": 2, "read": "2026-10-03"}, "notes": "The 9am-5pm rate applies on weekdays only. Pinergy 'Lifestyle & Smart Tariffs', correct as at 14 Sep 2026, inc VAT; standing €283.47 excludes the €19.10 PSO. Export 25c not re-read in this check.", "weekend": {"days": [5, 6], "rates": {"wfh": 0.458}, "same_as": {"wfh": "day"}}},
  {"id": "PIN-FAM", "supplier": "Pinergy", "plan": "Lifestyle Family Time", "type": "tou", "rates": {"day": 0.458, "night": 0.2748, "peak": 0.458, "ev": 0.2748}, "windows": {"peak": null, "night": [19, 24], "ev": null}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "verified_date": "2026-10-03", "source": {"url": "https://www.pinergy.ie/terms-conditions/tariffs/", "anchor": ["Family Time"], "fields": {"night": "Unit Price 7pm to midnight", "day": "Unit Price All other times", "standing": {"label": "Standing Charge", "col": 4}}, "col": 2, "read": "2026-10-03"}, "notes": "Cheap band 19:00-midnight every day. Pinergy 'Lifestyle & Smart Tariffs', correct as at 14 Sep 2026, inc VAT; standing €283.47 excludes the €19.10 PSO. Export 25c not re-read in this check."},
  {"id": "PIN-EV", "supplier": "Pinergy", "plan": "Lifestyle EV Night Time", "type": "ev", "rates": {"day": 0.4177, "night": 0.4177, "peak": 0.4177, "ev": 0.0599}, "windows": {"ev": [2, 5], "peak": null, "night": null}, "standing": 283.47, "exit": 50, "length": 12, "green": true, "export_rate": 0.25, "discontinued": true, "discontinued_date": "2026-05-21", "verified_date": "2026-09-15", "notes": "Pinergy: 'no longer on sale since 21 May 2026'."},
  {"id": "PPP-24", "supplier": "PrepayPower", "plan": "Standard 24 Hr (pay-as-you-go)", "type": "flat", "rates": {"day": 0.3762, "night": 0.3762, "peak": 0.3762, "ev": 0.3762}, "windows": {"ev": null}, "standing": 473.98, "exit": 0, "length": 12, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.prepaypower.ie/why-switch/pricing/rates", "anchor": ["PrepayPower Standard 24 Hr Urban"], "fields": {"day": {"label": "Standard Unit Rate", "col": 2}, "standing": ["Urban Standing Charge", "Prepayment Service Charge"]}, "col": 4, "read": "2026-10-03", "welcome": {"url": "https://www.prepaypower.ie/our-services/pre-pay-electricity", "anchor": [], "within": 400}}, "notes": "Early termination €11.25 per remaining month. PrepayPower rates page, 'correct as of 1st June 2026', urban, inc VAT. Standing shown here is the standing charge plus the prepayment service charge, both unavoidable on this product; PSO excluded. No export payment published.", "welcome_credit": 100.0},
  {"id": "PPP-NS", "supplier": "PrepayPower", "plan": "NightSaver (pay-as-you-go)", "type": "tou", "rates": {"day": 0.4206, "night": 0.2077}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 587.58, "exit": 0, "length": 12, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.prepaypower.ie/why-switch/pricing/rates", "anchor": ["PrepayPower Urban NightSaver"], "fields": {"day": {"label": "Standard Unit Rate Day", "col": 2}, "night": {"label": "Standard Unit Rate Night", "col": 2}, "standing": ["Urban Standing Charge", "Prepayment Service Charge"]}, "col": 4, "read": "2026-10-03", "welcome": {"url": "https://www.prepaypower.ie/our-services/pre-pay-electricity", "anchor": [], "within": 400}}, "notes": "Day & night meter. PrepayPower rates page, 'correct as of 1st June 2026', urban, inc VAT. Standing shown here is the standing charge plus the prepayment service charge, both unavoidable on this product; PSO excluded. No export payment published.", "welcome_credit": 100.0},
  {"id": "PPP-TOU", "supplier": "PrepayPower", "plan": "Smart Pay Day/Night/Peak (pay-as-you-go)", "type": "tou", "rates": {"day": 0.4165, "night": 0.216, "peak": 0.4681, "ev": 0.216}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 507.1, "exit": 0, "length": 12, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.prepaypower.ie/why-switch/pricing/rates", "anchor": ["PrepayPower Smart Pay Urban Day Night Peak"], "fields": {"day": {"label": "Unit Rate Day", "col": 2}, "night": {"label": "Unit Rate Night", "col": 2}, "peak": {"label": "Unit Rate Peak", "col": 2}, "standing": ["Urban Standing Charge", "Prepayment Service Charge"]}, "col": 4, "read": "2026-10-03", "welcome": {"url": "https://www.prepaypower.ie/our-services/pre-pay-smart-pay", "anchor": [], "within": 400}}, "notes": "Smart pay-as-you-go time of use. PrepayPower rates page, 'correct as of 1st June 2026', urban, inc VAT. Standing shown here is the standing charge plus the prepayment service charge, both unavoidable on this product; PSO excluded. No export payment published.", "welcome_credit": 100.0},
  {"id": "WP-24", "supplier": "Waterpower", "plan": "24 Hour (e-billing)", "type": "flat", "rates": {"day": 0.3142, "night": 0.3142, "peak": 0.3142, "ev": 0.3142}, "windows": {"ev": null}, "standing": 246.67, "exit": 0, "length": 0, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.waterpower.ie/current-electricity-rates/", "anchor": ["Domestic 24 Hour Urban"], "fields": {"day": "Unit Rate c/kwh  (E-Bill Only)", "standing": {"label": "Standing Charge Per Annum", "col": 2}}, "col": 2, "unit": "eur", "read": "2026-10-03"}, "notes": "waterpower.ie/current-electricity-rates, urban, e-billing, inc VAT; standing excludes the €19.10 PSO, listed separately. The page carries no date. Waterpower does not publish a Clean Export Guarantee rate, so export is 0 here and a home with solar is understated on this plan. Exit fee and contract length not published."},
  {"id": "WP-DN", "supplier": "Waterpower", "plan": "Day/Night (e-billing)", "type": "tou", "rates": {"day": 0.3296, "night": 0.2541}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 246.67, "exit": 0, "length": 0, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.waterpower.ie/current-electricity-rates/", "anchor": ["Domestic Day/Night (E-Billing) Urban"], "fields": {"day": "Unit Day Rate", "night": "Unit Night Rate", "standing": {"label": "Standing Charge Per Annum", "col": 2}}, "col": 2, "unit": "eur", "read": "2026-10-03"}, "notes": "waterpower.ie/current-electricity-rates, urban, e-billing, inc VAT; standing excludes the €19.10 PSO, listed separately. The page carries no date. Waterpower does not publish a Clean Export Guarantee rate, so export is 0 here and a home with solar is understated on this plan. Exit fee and contract length not published."},
  {"id": "WP-SST", "supplier": "Waterpower", "plan": "Smart Tariff (SST)", "type": "tou", "rates": {"day": 0.322, "night": 0.2284, "peak": 0.3658, "ev": 0.2284}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 246.67, "exit": 0, "length": 0, "green": false, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.waterpower.ie/current-electricity-rates/", "anchor": ["Waterpower Smart Tariff (SST) Urban"], "fields": {"day": "Unit Day Rate", "night": "Unit Night Rate", "peak": "Peak Rate", "standing": {"label": "Standing Charge Per Annum", "col": 2}}, "col": 2, "unit": "eur", "read": "2026-10-03"}, "notes": "waterpower.ie/current-electricity-rates, urban, e-billing, inc VAT; standing excludes the €19.10 PSO, listed separately. The page carries no date. Waterpower does not publish a Clean Export Guarantee rate, so export is 0 here and a home with solar is understated on this plan. Exit fee and contract length not published."},
  {"id": "CP-24", "supplier": "Community Power", "plan": "Standard Variable 24hr", "type": "flat", "rates": {"day": 0.3996, "night": 0.3996, "peak": 0.3996, "ev": 0.3996}, "windows": {"ev": null}, "standing": 302.01, "exit": 0, "length": 0, "green": true, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.communitypower.ie/tariffs", "anchor": ["Standard Variable Rate"], "fields": {"day": "24hr", "standing": {"label": "Total Per Year", "col": 2}}, "col": 2, "read": "2026-10-03"}, "notes": "communitypower.ie/tariffs, inc VAT, urban. UNVERIFIED from 1 Oct 2026: the page states these prices are effective 1 Oct 2025 to 30 Sep 2026 and no later list is published yet. Export not published."},
  {"id": "CP-DN", "supplier": "Community Power", "plan": "Standard Variable Day/Night", "type": "tou", "rates": {"day": 0.4189, "night": 0.2564}, "windows": {"peak": null, "night": [23, 8], "ev": null}, "standing": 302.01, "exit": 0, "length": 0, "green": true, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.communitypower.ie/tariffs", "anchor": ["Standard Variable Rate"], "fields": {"day": "Day", "night": "Night", "standing": {"label": "Total Per Year", "col": 2}}, "col": 2, "read": "2026-10-03"}, "notes": "communitypower.ie/tariffs, inc VAT, urban. UNVERIFIED from 1 Oct 2026: the page states these prices are effective 1 Oct 2025 to 30 Sep 2026 and no later list is published yet. Export not published."},
  {"id": "CP-SST", "supplier": "Community Power", "plan": "Smart SST", "type": "tou", "rates": {"day": 0.4189, "night": 0.2564, "peak": 0.4412, "ev": 0.2564}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 302.01, "exit": 0, "length": 0, "green": true, "export_rate": 0, "verified_date": "2026-10-03", "source": {"url": "https://www.communitypower.ie/tariffs", "anchor": ["Smart SST"], "fields": {"day": "Day", "night": "Night", "peak": "Peak", "standing": {"label": "Total Per Year", "col": 2}}, "col": 2, "read": "2026-10-03"}, "notes": "communitypower.ie/tariffs, inc VAT, urban. UNVERIFIED from 1 Oct 2026: the page states these prices are effective 1 Oct 2025 to 30 Sep 2026 and no later list is published yet. Export not published."},
  {"id": "BG-SMART-ALL-DAY-ELECTRICITY", "supplier": "Bord Gáis", "plan": "Smart All Day Electricity", "type": "flat", "rates": {"day": 0.3161, "night": 0.3161, "peak": 0.3161, "ev": 0.3161}, "windows": {"ev": null}, "standing": 244.76, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-09-15", "notes": "Not in Bord Gáis's new-customer plan list on 30 Sep 2026.", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "Bord Gais price announcement, 9 Sep 2026", "note": "Bord Gais unit rates +9.1%, standing +7.2% from 9 Oct 2026."}, "discontinued": true},
  {"id": "BG-SMART-STANDARD-GREEN-ELECTRICITY-ONLY", "supplier": "Bord Gáis", "plan": "Smart Standard Green Electricity Only", "type": "tou", "rates": {"day": 0.3378, "night": 0.2493, "peak": 0.4112, "ev": 0.2493}, "windows": {"peak": [17, 19], "night": [23, 8], "ev": null}, "standing": 244.76, "exit": 50, "length": 12, "green": true, "export_rate": 0.185, "verified_date": "2026-09-15", "notes": "Not in Bord Gáis's new-customer plan list on 30 Sep 2026.", "price_change": {"effective_date": "2026-10-09", "pct": 0.091, "standing_pct": 0.072, "direction": "increase", "source": "Bord Gais price announcement, 9 Sep 2026", "note": "Bord Gais unit rates +9.1%, standing +7.2% from 9 Oct 2026."}, "discontinued": true}
];

export let TARIFFS = EMBEDDED_TARIFFS.slice();
export function getPlanById(id){
  const base = TARIFFS.find(t => t.id === id);
  if (!base) return TARIFFS[0];
  const overrides = (state.plan_overrides || {})[id];
  if (!overrides) return base;
  // Merge user overrides on top of defaults so simulation uses edited rates
  return {
    ...base,
    rates: { ...base.rates, ...(overrides.rates || {}) },
    standing: overrides.standing !== undefined ? overrides.standing : base.standing,
    export_rate: overrides.export_rate !== undefined ? overrides.export_rate : base.export_rate,
    _is_edited: true
  };
}

// True if all band rates (day/night/peak/ev) are within 0.001c/kWh of each other

/* ============================================================
   7. SIMULATION ENGINE — hour-by-hour battery dispatch + costs
   ============================================================ */

export function simulate(plan, gen, cons, strategy){
  const cap = state.battery_kwh || 0;          // usable kWh
  const minSoc = state.battery_min * cap;
  const maxSoc = (state.battery_max || 1.0) * cap;
  const eff = Math.sqrt(state.battery_eff); // applied each way
  const maxChargeKw = 5.0;                       // typical hybrid inverter limit
  const maxDischargeKw = 5.0;
  const isDynamic = plan.type === "dynamic";

  // For dynamic tariffs: pre-compute effective rates for the year
  let effRates = null;
  if (isDynamic){
    effRates = new Float32Array(HOURS_IN_YEAR);
    for (let i=0; i<HOURS_IN_YEAR; i++){
      const hour = i % 24;
      effRates[i] = rateAt(hour, plan, i);
    }
  }

  // Hourly outputs
  const out = {
    gen: gen,
    cons: cons,
    soc: new Float32Array(HOURS_IN_YEAR+1),
    grid_import: new Float32Array(HOURS_IN_YEAR),
    grid_export: new Float32Array(HOURS_IN_YEAR),
    battery_charge: new Float32Array(HOURS_IN_YEAR),  // kWh into battery
    battery_discharge: new Float32Array(HOURS_IN_YEAR), // kWh out of battery
    self_use: new Float32Array(HOURS_IN_YEAR),       // solar used directly
    curtailed: new Float32Array(HOURS_IN_YEAR),      // solar wasted due to export disabled / limit reached
    cost: new Float32Array(HOURS_IN_YEAR),
    revenue: new Float32Array(HOURS_IN_YEAR),
    band: new Array(HOURS_IN_YEAR),
    eff_rate: effRates,                              // hourly effective rates (dynamic only)
    plan_id: plan.id
  };

  let soc = minSoc + 0.3*(cap - minSoc); // start at 30% above min
  const exportRate = plan.export_rate;
  const peakRate = plan.rates.peak;
  const evRate = plan.windows.ev ? plan.rates.ev : null;

  // Export hardware constraints — if disabled, surplus is curtailed (clipped, not earned)
  const exportEnabled = state.export_enabled !== false;
  const exportLimit = exportEnabled ? (state.export_limit_kw || 999) : 0;

  for (let i=0; i<HOURS_IN_YEAR; i++){
    out.soc[i] = soc;
    const hour = i % 24;
    const g = gen[i];
    const c = cons[i];
    const band = bandAt(hour, plan);
    out.band[i] = band;
    const rate = isDynamic ? effRates[i] : staticRateAt(i, plan, band);

    // For dynamic, determine if THIS hour is cheap vs the surrounding 24h
    let isCheapDynamic = false, isExpensiveDynamic = false, dailyAvg = 0;
    if (isDynamic){
      let sum = 0, n = 0;
      for (let k=0; k<24 && i+k<HOURS_IN_YEAR; k++){ sum += effRates[i+k]; n++; }
      dailyAvg = n > 0 ? sum/n : rate;
      isCheapDynamic = rate < dailyAvg * 0.65;
      isExpensiveDynamic = rate > dailyAvg * 1.40;
    }

    let netSolarAfterLoad = g - c;   // positive = surplus, negative = deficit
    let directSelfUse = Math.min(g, c);
    out.self_use[i] = directSelfUse;

    let charge = 0, discharge = 0, imp = 0, exp = 0;

    // === Strategy logic ===
    let curtailed = 0;
    if (netSolarAfterLoad > 0){
      // Solar surplus. Decide: store in battery vs export.
      const headroom = maxSoc - soc;
      const canStore = Math.min(headroom / eff, maxChargeKw, netSolarAfterLoad);
      // If export rate > expected discharge value AND export is enabled, prefer export
      const expectedDischargeValue = isDynamic ? dailyAvg * 1.5 : peakRate;
      if (exportEnabled && exportRate * 1.0 > expectedDischargeValue * eff * eff){
        exp = netSolarAfterLoad;
      } else {
        charge = canStore;
        soc += charge * eff;
        const leftover = netSolarAfterLoad - charge;
        exp = Math.max(0, leftover);
      }
      // Apply hardware constraint: cap export at limit (excess is curtailed, lost)
      if (exp > exportLimit){
        curtailed = exp - exportLimit;
        exp = exportLimit;
      }
      out.curtailed[i] = curtailed;
    } else if (netSolarAfterLoad < 0){
      // Deficit — need to import or discharge battery
      const deficit = -netSolarAfterLoad;

      // Cheap-window determination (when we charge from grid)
      const isCheapWindow = isDynamic
        ? isCheapDynamic
        : ((band === "ev") || (band === "night" && rate <= 0.20));

      // Expensive-window determination (when we want to discharge)
      const isExpensiveWindow = isDynamic
        ? isExpensiveDynamic
        : (band === "peak" || band === "day");

      if (isExpensiveWindow && !isCheapWindow){
        // Discharge to meet load
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw);
        const energyOut = dis * eff;
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - energyOut);
      } else if (isCheapWindow){
        // Cheap — charge battery from grid + meet load from grid
        if (strategy.charge_from_grid){
          const headroom = maxSoc - soc;
          // For dynamic: only charge if room AND we have hours that are noticeably cheap
          const chargeAmt = Math.min(headroom / eff, maxChargeKw);
          charge = chargeAmt;
          soc += chargeAmt * eff;
          imp = deficit + charge;
        } else {
          imp = deficit;
        }
      } else {
        // Neutral hour — meet load with battery if available, else import
        const usable = Math.max(0, soc - minSoc);
        const dis = Math.min(usable, deficit / eff, maxDischargeKw * 0.5);
        const energyOut = dis * eff;
        soc -= dis;
        discharge = dis;
        imp = Math.max(0, deficit - energyOut);
      }
    }

    out.grid_import[i] = imp;
    out.grid_export[i] = exp;
    out.battery_charge[i] = charge;
    out.battery_discharge[i] = discharge;
    out.cost[i] = imp * rate;
    out.revenue[i] = exp * exportRate;
  }
  out.soc[HOURS_IN_YEAR] = soc;
  return out;
}

/* ============================================================
   8. ORCHESTRATOR + CACHE
   ============================================================ */
export const CACHE = { solar:null, cons:null, consNoEv:null, wholesale:null, dirty:true, sims:{}, baselines:{} };

export function rebuildBase(){
  CACHE.solar = buildSolar();
  const consResult = buildConsumption();
  CACHE.cons = consResult.cons;
  CACHE.consNoEv = consResult.consNoEv;
  CACHE.wholesale = buildWholesale();
  CACHE.sims = {};
  CACHE.baselines = {};
  CACHE.dirty = false;
}

export function sim(planId){
  if (CACHE.dirty) rebuildBase();
  if (CACHE.sims[planId]) return CACHE.sims[planId];
  const plan = getPlanById(planId);
  // Build strategy object on the fly from flat state (matches tool's interface)
  const eff = effectiveStrategy();
  const run = (mode, fromGrid) => {
    const r = simulate(plan, CACHE.solar.total, CACHE.cons, {
      mode, charge_from_grid: fromGrid,
      arbitrage_priority: 0.7, discharge_strategy: 'peak_first', reserve_for_evening: 0.0,
    });
    const sdf = baselineDiscountFactor(planId);
    if (sdf !== 1){ for (let i = 0; i < r.cost.length; i++) r.cost[i] *= sdf; }
    r.strategy_used = mode === 'arbitrage' && fromGrid ? 'arbitrage' : 'self-consume';
    return r;
  };
  let ssim;
  if (eff.hasBattery && eff.mode === 'auto'){
    // What an owner would do: set the inverter to whichever pays on this plan.
    // Grid charging earns on a plan with a cheap window and loses round-trip
    // energy on a flat one, so the choice is per plan, not global.
    const a = run('arbitrage', true), b = run('self-consume', false);
    ssim = annualCost(a, plan).net <= annualCost(b, plan).net ? a : b;
  } else {
    ssim = run(eff.mode, eff.charge_from_grid);
  }
  CACHE.sims[planId] = ssim;
  return CACHE.sims[planId];
}
export function baselineSim(planId){
  if (CACHE.dirty) rebuildBase();
  if (CACHE.baselines[planId]) return CACHE.baselines[planId];
  // EV semantics: an OWNER's bill (ev_in_bill) includes the car, so their
  // current-plan cost must simulate the full load incl. EV. A PLANNER's bill
  // is pre-car, so the baseline stays as-billed and the EV only appears in
  // the forward-looking comparisons.
  const baseCons = (state.ev_active && state.ev_in_bill) ? CACHE.cons : CACHE.consNoEv;
  const bsim = simulateBaseline(getPlanById(planId), baseCons);
  const df = baselineDiscountFactor(planId);
  if (df !== 1){ for (let i = 0; i < bsim.cost.length; i++) bsim.cost[i] *= df; }
  CACHE.baselines[planId] = bsim;
  return CACHE.baselines[planId];
}

/**
 * What the current plan costs over the year ahead, on the bill's own load:
 * energy, standing charge and PSO, plus any announced price rise for the part
 * of the year it applies to — the same footing every other plan is ranked on.
 * Leaving the rise out made the current plan look cheaper than it will be,
 * and a "best" plan could then cost more than it.
 */
export function baselineNet(planId){
  const bs = baselineSim(planId);
  if (!bs) return 0;
  const plan = getPlanById(planId);
  return sumF(bs.cost) + (plan ? plan.standing + PSO_LEVY + annualCost(bs, plan).outlook_extra : 0);
}

// Coerce critical numeric state to real, in-range numbers. State can arrive
// from a shared ?s= URL or hand-edited localStorage, where a field might be a
// string ("10") or NaN — "10" is truthy so it slips past `|| 0` and then breaks
// arithmetic downstream. Run on every invalidate so the engine only ever sees
// clean numbers.
export const NUMERIC_STATE_FIELDS = {
  bimonthly_bill_eur: [250, 0, 100000],
  annual_kwh:         [0, 0, 200000],
  baseline_discount_pct: [0, 0, 60],
  count_A:    [0, 0, 200],
  count_B:    [0, 0, 200],
  tilt_A:     [30, 0, 90],
  tilt_B:     [30, 0, 90],
  azimuth_A:  [180, 0, 360],
  azimuth_B:  [180, 0, 360],
  panel_w:    [460, 100, 800],
  battery_kwh:[0, 0, 200],
  install_cost: [0, 0, 1000000],
  grant_seai:   [0, 0, 100000],
  ev_km:      [0, 0, 200000],
  ev_eff:     [17, 1, 100],
  fuel_price: [1.83, 0, 100]
};
export function coerceNumericState(){
  // A home that cannot get the SEAI grant gets none, whatever a quote, a
  // suggestion or a saved system says: every simulation passes through here.
  if (state.grant_eligible === false) state.grant_seai = 0;
  for (const k in NUMERIC_STATE_FIELDS){
    if (!(k in state)) continue;
    const [fallback, min, max] = NUMERIC_STATE_FIELDS[k];
    let v = Number(state[k]);
    if (!Number.isFinite(v)) v = fallback;
    state[k] = Math.min(max, Math.max(min, v));
  }
}

/**
 * Depth of the current what-if batch.
 *
 * The scenario runners work by mutating state, rebuilding, measuring and
 * restoring — and every rebuild calls invalidate(), which clears the memo
 * caches. So computeScenarioRange() ran twelve scenarios and, on its way out,
 * destroyed the very cache computeSolarPaybackScenarios() had just written.
 * Nothing was ever reused: the solar screen re-ran the 8,760-hour simulation
 * from scratch on every single render, which is 57% of a 1.1-second paint.
 *
 * While a batch is in flight the memos are left alone; the batch owns them and
 * writes the final value itself against a checksum of the real inputs.
 */
export let _scenarioDepth = 0;

/**
 * Scenario results by checksum. Small and bounded: one render needs at most the
 * average year plus the two range variants.
 */
export const scenarioMemo = new Map();

/*
 * The cost comparison and the "make it pay back faster" list each need whole
 * extra rankings of every plan (with solar removed; with each lever applied).
 * Worked out inside the first paint they held the payback figure back by over
 * a second, so they are drawn a moment after it, as the design sweep is.
 */
export let _solarExtrasReady = false, _solarExtrasPending = false;

export function invalidate(){
  coerceNumericState();
  CACHE.dirty = true;
  if (_scenarioDepth === 0){
    CACHE._opt = null;
    CACHE._opt_ck = null;
    scenarioMemo.clear();
    singleScenarioMemo.clear();
    CACHE._range = null;
    CACHE._range_ck = null;
    _solarExtrasReady = false;
  }
  // _goalSweep survives invalidate deliberately: its checksum (goalSweepCk)
  // covers all inputs that affect it, and the sweep itself is independent of
  // the currently-applied system config.
  // Re-apply region's GHI multiplier so engine uses correct sunshine for selected county
  applyRegion(state.region || 'east');
  // Sanitize HW strategy: if heating type is gas/oil/none and HW is electric (smart/legacy),
  // reset to none. This avoids the "gas combi + smart timer" trap that artificially
  // favors EV plans by shifting 15% of phantom load to 2-5am cheap window.
  const ht = state.heating_type;
  if ((ht === 'gas' || ht === 'oil' || ht === 'none') && state.hot_water_strategy !== 'none'){
    state.hot_water_strategy = 'none';
  }
  // A battery strategy with no battery is simply not in effect — see
  // effectiveStrategy(). It used to be written back into state here, which
  // destroyed the user's own choice: every routine that trials a batteryless
  // design (the twelve-design sweep, the recommended-system search, the report
  // levers) zeroes battery_kwh, invalidates, and restores the battery
  // afterwards — but none of them knew to restore a setting they never touched.
  // So arbitrage silently switched itself off while the reader was clicking
  // around, and stayed off.
}

/**
 * The battery strategy actually in force.
 *
 * state.strategy_mode is what the user asked for and is never overwritten by
 * the engine. With no battery installed it cannot apply, so everything that
 * simulates or displays the strategy reads it through here.
 */
export function effectiveStrategy(){
  const hasBattery = (state.battery_kwh || 0) > 0;
  return {
    mode: hasBattery ? (state.strategy_mode || 'auto') : 'self-consume',
    charge_from_grid: hasBattery ? state.charge_from_grid !== false : false,
    hasBattery,
  };
}

/* ============================================================
   8b. SIMULATING A HYPOTHETICAL WITHOUT LOSING THE USER'S STATE
   ============================================================

   Half the app's value comes from answering "what if?" — what if there were no
   panels, what if the battery were bigger, what if this lever were flipped. The
   engine reads global state, so every one of those questions is asked by
   mutating `state`, simulating, and putting it back.

   Putting it back was done by hand, at five call sites, each with its own list
   of fields to save. That produced the same bug twice:

     · generating a report permanently switched the battery to self-consume,
       because a lever set battery_kwh to 0 and the sanitiser rewrote the
       strategy, which the lever's snapshot did not include;
     · arbitrage switched itself off while the reader clicked around, because
       the design sweep and the recommended-system search zero the battery too,
       and their snapshots did not include it either.

   Both were a field somebody forgot. A hand-written list per call site means
   four chances to forget and no way to notice: the restore silently succeeds,
   and the user's setting is simply gone.

   One list, used everywhere. Adding a field to state means adding it here once.
   ============================================================ */

/**
 * Every field the engine reads, or that the sanitiser may rewrite, while a
 * hypothetical is being simulated.
 *
 * Deliberately broader than any one call site needs. Restoring a field that
 * never changed costs nothing; failing to restore one costs the user's setting.
 */
export const SIM_FIELDS = [
  'has_solar', 'solar_planned', 'count_A', 'count_B',
  'azimuth_A', 'azimuth_B', 'tilt_A', 'tilt_B', 'panel_w', 'panel_degradation',
  'battery_kwh', 'strategy_mode', 'charge_from_grid',
  'install_cost', 'grant_seai',
  'ev_active', 'ev_in_bill', 'ev_km_per_year', 'ev_kwh_per_100km',
  'heating_type', 'hot_water_strategy', 'region',
  'baseline', 'baseline_discount_pct', 'chosen_plan', 'include_dynamic',
  // Registering for export payments is a lever the optimisation advisor trials
  // by turning it OFF. It was missing here, so opening the Solar tab left it
  // off: every figure afterwards was computed with the export income deleted —
  // 2,448 kWh/yr of it — and the payback on a 10-panel, 9 kWh system read 14.4
  // years instead of 9.3.
  'export_enabled', 'export_limit_kw',
  'bills', 'annual_kwh', 'usage_input_mode', 'bimonthly_bill_eur',
  // Economic inputs. coerceNumericState() writes every numeric field back on
  // each invalidate, so a hypothetical touches these whether it meant to or
  // not — sim-state.spec.js caught fuel_price missing from this list.
  'fuel_price', 'ice_l_per_100km', 'ev_km', 'ev_eff',
  '_ghi_override',
];

/**
 * A copy of the simulation state.
 *
 * Shallow, which is what the hand-written versions were: `bills` is captured by
 * reference, so a trial must replace it rather than mutate it in place. Every
 * current caller does.
 */
export function snapshotSim(){
  const snap = {};
  for (const k of SIM_FIELDS) snap[k] = state[k];
  return snap;
}

export function restoreSim(snap){
  Object.assign(state, snap);
}

/**
 * Run `fn` with `changes` applied to state, then restore everything.
 *
 * The restore runs in a finally block: a parser throwing halfway through a
 * hypothetical must not leave the user looking at a home they do not own.
 */
export function withSimState(changes, fn){
  // Snapshot the standing list AND whatever this call is about to overwrite.
  // The list is maintained by hand and has now been wrong three times; a change
  // the caller is explicitly making is one the caller cannot forget to declare,
  // so take it from the argument rather than from anybody's memory.
  const snap = snapshotSim();
  if (changes) for (const k in changes) if (!(k in snap)) snap[k] = state[k];
  _scenarioDepth += 1;
  try {
    if (changes) Object.assign(state, changes);
    invalidate();
    rebuildBase();
    return fn();
  } finally {
    // Restore while still inside the hypothetical: putting state back is part
    // of the hypothetical, not a change to report. Decrementing first made
    // every trial log its own tidy-up and buried the real event.
    restoreSim(snap);
    _scenarioDepth -= 1;
    invalidate();
    rebuildBase();
  }
}

/**
 * A single scenario, memoised and guarded.
 *
 * runScenario() mutates state, rebuilds and restores, and each rebuild
 * invalidates every memo in the app. Calling it straight from a render meant
 * the solar screen recomputed 286 full-year simulations on every paint and
 * wiped the payback memo on the way past.
 */
export const singleScenarioMemo = new Map();

/**
 * Is `plan` one the ranking can offer? Discontinued plans cannot be switched
 * to, and dynamic ones are held back unless the user opts in.
 */
export function isRankablePlan(plan){
  if (!plan || plan.discontinued) return false;
  if (plan.type === 'dynamic' && !state.include_dynamic) return false;
  return true;
}

/**
 * Evaluate the hand-picked plan, or null if there isn't a usable one.
 *
 * A stored choice can go stale — the plan may be withdrawn by the supplier on
 * the next tariff refresh, or the user may turn dynamic plans back off. Rather
 * than fail, fall through to the ranking; the surfaces that matter show the
 * choice explicitly, so its disappearance is visible.
 */
export function evaluateChosenPlan(){
  const id = state.chosen_plan;
  if (!id) return null;
  const plan = getPlanById(id);
  if (!isRankablePlan(plan)) return null;
  const s = sim(plan.id);
  const c = annualCost(s, plan);
  return { plan, sim: s, net: c.net, ...c, isChosen: true };
}

/**
 * The plan the rest of the app should reason about.
 *
 * Normally that is the cheapest for this household. If the user has picked a
 * plan by hand — a fixed-term deal they want for its own reasons, a supplier
 * they will not leave — that choice wins, and every downstream figure (savings,
 * solar payback, the report) is computed on it instead. `isChosen` lets a
 * surface say so rather than presenting a manual pick as our recommendation.
 *
 * `opts.ignoreChoice` re-optimises regardless, for counterfactuals that must
 * not inherit the choice — see runScenario().
 */
export function getBestPlan(opts){
  if (CACHE.dirty) rebuildBase();
  let best = opts && opts.ignoreChoice ? null : evaluateChosenPlan();
  // EXCLUDE discontinued plans (can't be switched to) and — for now — dynamic
  // wholesale-tracking plans: their pricing is too unpredictable to rank
  // honestly until clarity is established. Opt back in via Expert settings.
  if (!best){
    for (const plan of TARIFFS){
      if (!isRankablePlan(plan)) continue;
      const s = sim(plan.id);
      const c = annualCost(s, plan);
      if (!best || c.net < best.net){
        best = { plan, sim: s, net: c.net, ...c, isChosen: false };
      }
    }
  }
  // No rankable plan at all (every tariff discontinued/filtered, or the data
  // failed to load). Return a clearly-flagged null result instead of letting
  // `best.plan.id` throw a cascade of errors across the result screen.
  if (!best){ return { plan: null, sim: null, net: 0, energy_cost: 0, export_revenue: 0, standing: 0, baseCost: 0, savings: 0, _noPlan: true }; }
  const baselinePlan = getPlanById(state.baseline);
  const bs = baselineSim(state.baseline);
  const baseCost = bs ? baselineNet(state.baseline) : 0;
  best.baseCost = baseCost;
  best.savings = baseCost - best.net;
  return best;
}

/* ============================================================
   10b. SINGLE SOURCE OF TRUTH — recommendation + counts
   ============================================================
   Root cause of the three-surface mismatch (P0.1):
   - getBestPlan() correctly filters out dynamic plans (unless include_dynamic).
   - rankOfPlan() did NOT apply the same dynamic filter, so its `total` was 26
     (all non-discontinued) while getBestPlan() ranked against 25.
   - Result screen, Monitor, and Analytics each computed plan/savings independently,
     so any difference in state at call-time (cache staleness, filter state) could
     produce different numbers.
   Fix: getRecommendation() is the one place that does this work. Every screen
   reads from it. rankOfPlan() now also respects the dynamic filter so counts align.
   ============================================================ */
export function getRecommendation(){
  if (CACHE.dirty) rebuildBase();
  const totalNonDiscontinued = TARIFFS.filter(p => !p.discontinued).length;
  const dynamicCount = TARIFFS.filter(p => !p.discontinued && p.type === 'dynamic').length;
  const excludedCount = state.include_dynamic ? 0 : dynamicCount;
  const rankedCount = totalNonDiscontinued - excludedCount;

  // Rank plans — mirrors getBestPlan() filter exactly
  const ranked = [];
  for (const plan of TARIFFS){
    if (!isRankablePlan(plan)) continue;
    const s = sim(plan.id);
    const c = annualCost(s, plan);
    ranked.push({ plan, sim: s, net: c.net, ...c });
  }
  ranked.sort((a, b) => a.net - b.net);

  // `cheapest` is what the ranking says; `best` is what the app acts on. They
  // differ only when the user has chosen a plan by hand.
  const cheapest = ranked[0] || null;
  const chosenIdx = state.chosen_plan
    ? ranked.findIndex(r => r.plan.id === state.chosen_plan)
    : -1;
  const best = chosenIdx >= 0 ? ranked[chosenIdx] : cheapest;
  const isManualChoice = chosenIdx >= 0;
  const chosenRank = chosenIdx >= 0 ? chosenIdx + 1 : null;
  // What sticking with the hand-picked plan costs against the cheapest.
  const choicePremium = isManualChoice && cheapest ? best.net - cheapest.net : 0;
  const baselinePlan = getPlanById(state.baseline);
  const bs = baselineSim(state.baseline);
  const baseCost = bs ? baselineNet(state.baseline) : 0;
  const annualSavings = best ? Math.max(0, baseCost - best.net) : 0;
  const baselineRank = best ? (ranked.findIndex(r => r.plan.id === state.baseline) + 1) : null;

  const excludedNote = excludedCount > 0
    ? ` — ${excludedCount} dynamic plan${excludedCount > 1 ? 's' : ''} excluded (enable in Settings)`
    : '';

  return {
    best,                   // the plan in effect (chosen if set, else cheapest)
    cheapest,               // always rank 1, regardless of any manual choice
    isManualChoice,         // true when `best` is the user's pick, not the ranking's
    chosenRank,             // 1-based rank of that pick, null if none
    choicePremium,          // €/yr it costs versus the cheapest plan
    ranked,                 // all rankable plans sorted cheapest-first
    baseCost,
    annualSavings,
    rankedCount,            // plans in the ranking (dynamic excluded if setting off)
    totalPlanCount: totalNonDiscontinued,
    excludedCount,
    baselineRank,           // rank of the user's current plan (1-based)
    countLabel: `${rankedCount} of ${totalNonDiscontinued}${excludedNote}`,
  };
}

// When the user has told us their actual plan, the flat market-average €/kWh
// conversion is wrong — someone on a cheap EV/night tariff buys far more kWh
// per euro. Iteratively rescale the inferred kWh until the simulated annual
// cost on THEIR plan matches what they actually pay. Skipped when real smart
// meter data is loaded (truth beats inference) or the plan isn't confirmed.
// Discount multiplier for the user's CURRENT plan. A 20% sign-up discount
// (or equivalent legacy rates) means every unit-rate euro costs them 0.80.
// Applies only to the baseline plan id — candidate plans always rank at
// today's sticker prices, because that's what a switcher would pay.
export function baselineDiscountFactor(planId){
  const pct = +state.baseline_discount_pct || 0;
  if (!pct || planId !== state.baseline) return 1;
  return Math.min(1.5, Math.max(0.2, 1 - pct / 100));
}

// Typical 2026 Irish install price for a spec — same benchmarks the quote
// auditor uses (midpoint of €950-1,200/kWp + €350-480/kWh + €1,100-1,300 fixed).
// Calibrated against real Cork-market quotes: 12 panels + 9 kWh ≈ €9.5k-12k gross.
// 20-yr NPV — same constants as the NPV breakdown card (3% discount, 0.5%/yr
// panel degradation, battery replacement at year 12 priced €400/kWh).
export function computeNpv20(annualBenefit, sysCostNet, batteryKwh){
  const r = 0.03, deg = 0.005;
  let cumulative = -sysCostNet;
  for (let y = 1; y <= 20; y++){
    cumulative += (annualBenefit * Math.pow(1 - deg, y - 1)) / Math.pow(1 + r, y);
    if (batteryKwh > 0 && y === 12) cumulative -= 400 * batteryKwh / Math.pow(1 + r, 12);
  }
  return Math.round(cumulative);
}

// ════════════════════════════════════════════════════════════
// GOAL-DRIVEN SYSTEM DESIGNER
// Sweeps candidate designs (panels × battery) against all plans on the
// user's real load, ONCE, then both goals read from the same table:
//   'payback' → minimise net-cost / annual-benefit
//   'npv'     → maximise 20-yr discounted value
// Costs use the 2026 install benchmark + auto SEAI grant. Benefit is the
// electricity-only solar benefit — identical convention to the hero.
// ════════════════════════════════════════════════════════════
export const GOAL_PANELS = [6, 9, 12, 15];
export const GOAL_BATTS  = [0, 5, 10];

export function goalSweepCk(){
  return JSON.stringify(['goalsweep', state.region, state.heating_type, state.bimonthly_bill_eur,
    JSON.stringify(state.bills), state.ev_active, state.ev_in_bill, state.ev_km_per_year,
    state.ev_kwh_per_100km, state.azimuth_A, state.tilt_A, state.panel_w, state.hot_water_strategy, state.grant_eligible !== false,
    // The roof as it is used: one face, or two and how the panels share them.
    state.count_B > 0 ? [state.azimuth_B, state.tilt_B, +(state.count_B / Math.max(1, totalPanels())).toFixed(2)] : 0]);
}

export function estimateInstallCost(kwp, battKwh){
  // Non-linear: a fixed base (inverter, scaffolding, labour baseline) is paid
  // regardless of array size, then panels get cheaper per kWp at scale.
  //   base €3,300 · first 3 kWp at €1,000/kWp · beyond 3 kWp at €800/kWp
  //   battery: €800 hybrid-inverter/install premium + €380/kWh
  // Set to the middle of 2026 Irish guides: 6 kWp €8,500–10,500 before the
  // grant, batteries €2,500–6,000 fitted. A real 2026 Cork quote
  // (5.5 kWp + 9 kWh, €11,400) sits below this, as competitive quotes do.
  const panelCost = kwp <= 3 ? kwp * 1000 : 3 * 1000 + (kwp - 3) * 800;
  const battCost = (battKwh || 0) > 0 ? 800 + battKwh * 380 : 0;
  return Math.round((3300 + panelCost + battCost) / 100) * 100;
}

/* ============================================================
   SPRINT 3 — SEAI GRANT CALCULATOR (F5)
   2024 SEAI Home Solar Scheme — tiered structure
   ============================================================ */
export function calcSeaiGrant(kwp, batteryKwh){
  if (state.grant_eligible === false) return { panels: 0, battery: 0, total: 0 };
  // SEAI Home Solar Scheme — current structure (2024/2025):
  // First 2 kWp: €900/kWp  →  maximum grant = €1,800
  // Cap: €1,800 total (no battery bonus, no higher tiers as of 2025)
  if (kwp <= 0) return { panels: 0, battery: 0, total: 0 };
  const panelGrant = Math.min(kwp, 2) * 900;
  const total = Math.min(Math.round(panelGrant), 1800);
  return { panels: total, battery: 0, total };
}

// Setters for the values main.js replaces.
export function setState(v){ state = v; }
export function setTariffs(v){ TARIFFS = v; }
export function setSolarExtrasReady(v){ _solarExtrasReady = v; }
export function setSolarExtrasPending(v){ _solarExtrasPending = v; }
export function adjScenarioDepth(d){ _scenarioDepth += d; }

/* ---- The two background jobs, shared by the page and src/sim-worker.js ----
 * Same sums in both places: the page uses them when a worker is not
 * available, the worker otherwise. */

/** A system's figures against what the home pays with no panels. */
export function outcomeAgainst(noSolarNet){
  const best = getBestPlan();
  const ben = Math.max(0, noSolarNet - best.net);
  const grantOn = !(state.grant_is_manual && !(state.grant_seai > 0));
  const cost = Math.max(0, (state.install_cost || 0) - (grantOn ? (state.grant_seai || 0) : 0));
  const deg = state.panel_degradation || 0.005;
  let saved = 0; for (let y = 1; y <= 20; y++) saved += ben * Math.pow(1 - deg, y - 1);
  const batt = state.battery_kwh > 0 ? 400 * state.battery_kwh : 0;
  return { payback: ben > 0 ? cost / ben : 999, benefit: ben, cost, life: saved - cost - batt, plan: `${best.plan.supplier} ${best.plan.plan}` };
}
/** What the home pays on its best plan with no panels. */
export function noSolarNetNow(){
  return withSimState({ count_A: 0, count_B: 0, battery_kwh: 0, has_solar: false }, () => getBestPlan().net);
}
/** The twelve sizes, laid out on the roof as the home uses it. */
export function sweepSetup(){
  const two = state.count_B > 0;
  return { list: GOAL_PANELS.flatMap((p) => GOAL_BATTS.map((b) => [p, b])),
    az: state.azimuth_A || 180, tilt: state.tilt_A || 30, two, azB: state.azimuth_B, tiltB: state.tilt_B,
    shareB: two ? state.count_B / Math.max(1, totalPanels()) : 0 };
}
/** One size: its price, grant and what it earns on its best plan. */
export function evaluateDesign(J, p, b, noSolar){
  const nB = Math.round(p * J.shareB), nA = p - nB;
  const kwp = p * (state.panel_w || 440) / 1000;
  const cost = estimateInstallCost(kwp, b), grant = calcSeaiGrant(kwp, b).total, net = cost - grant;
  const ch = { count_A: nA, count_B: nB, azimuth_A: J.az, tilt_A: J.tilt, battery_kwh: b, has_solar: true, install_cost: cost, grant_seai: grant };
  if (J.two){ ch.azimuth_B = J.azB; ch.tilt_B = J.tiltB; }
  const best = withSimState(ch, () => getBestPlan());
  const benefit = Math.max(0, noSolar - best.net);
  const payback = benefit > 0 ? net / benefit : 999;
  return { panels: p, a: nA, b: nB, batt: b, kwp: +kwp.toFixed(1), cost, grant, net,
    benefit: Math.round(benefit), payback: +payback.toFixed(1), npv: computeNpv20(benefit, net, b), planId: best.plan.id,
    planLabel: best.plan.supplier + ' — ' + best.plan.plan };
}
export function finishSweep(designs, noSolar){
  return { designs, byPayback: designs.slice().sort((a, b) => a.payback - b.payback || a.net - b.net),
    byNpv: designs.slice().sort((a, b) => b.npv - a.npv || a.payback - b.payback), noSolarCost: Math.round(noSolar) };
}

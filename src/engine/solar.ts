/**
 * Solar physics: NOAA solar position, Erbs diffuse split, isotropic plane-of-array
 * transposition, and an NOCT temperature derate.
 *
 * Every function here is pure and takes its location explicitly. The original
 * versions read a module-level mutable `LOCATION` that `applyRegion()` swapped
 * out, which meant a result silently depended on whichever region was selected
 * last — untestable, and a real hazard when simulating scenarios side by side.
 */

import {
  DAYS_IN_MONTH, DEG, HOURS_IN_YEAR, dayOfYear,
  type LocationProfile,
} from './constants.js';

export interface SolarPosition {
  /** Radians above the horizon. Negative below. */
  altitude: number;
  /** Radians clockwise from north. */
  azimuth: number;
}

/** NOAA solar position for a day of year and (fractional) local hour. */
export function solarPosition(doy: number, hour: number, lat: number, lon: number): SolarPosition {
  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (hour - 12) / 24);
  const decl = 0.006918
    - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const eqtime = 229.18 * (0.000075
    + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const timeOffset = eqtime + 4 * lon;
  const tst = hour * 60 + timeOffset;
  const ha = (tst / 4 - 180) * DEG;
  const latR = lat * DEG;
  const sinAlt = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(decl) - Math.sin(altitude) * Math.sin(latR))
    / (Math.cos(altitude) * Math.cos(latR));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (ha > 0) azimuth = 2 * Math.PI - azimuth;
  return { altitude, azimuth };
}

/** Erbs model: diffuse fraction of global irradiance from clearness index. */
export function erbsDiffuse(kt: number): number {
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.80) {
    return 0.9511 - 0.1604 * kt + 4.388 * kt * kt
      - 16.638 * Math.pow(kt, 3) + 12.336 * Math.pow(kt, 4);
  }
  return 0.165;
}

/**
 * Day-to-day clearness weights for a month, mean exactly 1.
 *
 * Every day used to receive the month's average irradiance, which is wrong in a
 * way that matters. Real Irish months are a mix of bright days and washouts,
 * and the difference is not cosmetic: on a clear day most of the light arrives
 * as beam, which a tilted array collects far better than diffuse. Averaging the
 * weather away removes every clear hour from the year, so Erbs — an hourly
 * correlation — sees a permanently hazy sky and reports a diffuse fraction near
 * 0.8 all year. That is what made roof pitch almost irrelevant.
 *
 * Deterministic by design: the same household must get the same answer twice.
 * The spread is bimodal-ish and modest, and the weights are normalised so the
 * monthly total still matches the location profile exactly.
 */
function clearnessWeights(monthIndex: number, days: number): number[] {
  const w: number[] = [];
  // Cheap deterministic sequence — reproducible across runs and machines.
  let seed = (monthIndex + 1) * 9781;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let d = 0; d < days; d += 1) {
    const u = next();
    // Skewed toward dull days with a tail of bright ones, which is the shape of
    // an Irish month far better than a flat average.
    w.push(0.25 + 1.55 * u * u);
  }
  const mean = w.reduce((a, b) => a + b, 0) / Math.max(1, days);
  return w.map((x) => x / mean);
}

/**
 * Hourly global horizontal irradiance for a year, Wh/m².
 *
 * Monthly totals are distributed across days by a clearness weight and then
 * across daylight hours in proportion to solar altitude, so the monthly energy
 * matches the location profile exactly while individual days differ.
 */
/**
 * The most global horizontal irradiance a day can physically receive, Wh/m².
 *
 * Extraterrestrial irradiance on the horizontal, times the highest clearness
 * index the atmosphere allows. 0.75 is the practical ceiling for a cloudless
 * day at Irish latitudes; the theoretical limit is a little higher but is not
 * reached at sea level in a maritime climate.
 */
const MAX_CLEARNESS = 0.75;

function clearSkyDailyGhi(doy: number, lat: number, lon: number): number {
  let total = 0;
  const e0 = extraterrestrialNormal(doy);
  for (let h = 0; h < 24; h += 1) {
    const pos = solarPosition(doy, h + 0.5, lat, lon);
    total += Math.max(0, Math.sin(pos.altitude)) * e0;
  }
  return total * MAX_CLEARNESS;
}

export function buildHourlyGhi(location: LocationProfile): Float32Array {
  const ghi = new Float32Array(HOURS_IN_YEAR);
  let hourIdx = 0;
  for (let m = 0; m < 12; m += 1) {
    const monthlyDailyGhi = (location.ghi_kwh_m2_day[m] ?? 0) * 1000;
    const days = DAYS_IN_MONTH[m] ?? 0;
    const weights = clearnessWeights(m, days);

    /*
     * Cap each day at clear sky, and give the surplus to the days that still
     * have room.
     *
     * The weights spread a month's energy across its days so that no two days
     * look alike, which is honest — but nothing checked the result against what
     * the sky can actually deliver. On a 5.3 kWp array the brightest day came
     * out at 40.3 kWh, or 7.64 kWh per kWp, when Ireland's very best day is
     * about 6.5. A reader scrubbing through the day inspector was shown a day
     * that cannot happen.
     *
     * The month's total is preserved exactly: energy removed from a day that
     * exceeded the ceiling is redistributed in proportion to the headroom left
     * on the others. A few passes settle it; if every day is at the ceiling
     * there is nowhere left to put it, and the loop stops rather than
     * manufacturing irradiance.
     */
    const ceilings: number[] = [];
    const dayGhis: number[] = [];
    for (let d = 0; d < days; d += 1) {
      const doy = dayOfYear(m, d + 1);
      ceilings.push(clearSkyDailyGhi(doy, location.lat, location.lon));
      dayGhis.push(monthlyDailyGhi * (weights[d] ?? 1));
    }
    for (let pass = 0; pass < 8; pass += 1) {
      let surplus = 0;
      for (let d = 0; d < days; d += 1) {
        const over = (dayGhis[d] ?? 0) - (ceilings[d] ?? 0);
        if (over > 0) { surplus += over; dayGhis[d] = ceilings[d] ?? 0; }
      }
      if (surplus <= 1e-6) break;
      let headroom = 0;
      for (let d = 0; d < days; d += 1) headroom += Math.max(0, (ceilings[d] ?? 0) - (dayGhis[d] ?? 0));
      if (headroom <= 1e-6) break;   // the whole month is at clear sky
      for (let d = 0; d < days; d += 1) {
        const room = Math.max(0, (ceilings[d] ?? 0) - (dayGhis[d] ?? 0));
        dayGhis[d] = (dayGhis[d] ?? 0) + surplus * (room / headroom);
      }
    }

    for (let d = 0; d < days; d += 1) {
      const doy = dayOfYear(m, d + 1);
      const dayGhi = dayGhis[d] ?? 0;
      const altitudes: number[] = [];
      for (let h = 0; h < 24; h += 1) {
        const pos = solarPosition(doy, h + 0.5, location.lat, location.lon);
        altitudes.push(Math.max(0, Math.sin(pos.altitude)));
      }
      const sumAlt = altitudes.reduce((a, b) => a + b, 0);
      for (let h = 0; h < 24; h += 1) {
        const frac = sumAlt > 0 ? (altitudes[h] ?? 0) / sumAlt : 0;
        ghi[hourIdx] = dayGhi * frac;
        hourIdx += 1;
      }
    }
  }
  return ghi;
}

/** Solar constant, W/m². */
const SOLAR_CONSTANT = 1367;

/**
 * Extraterrestrial irradiance on a plane normal to the beam, W/m².
 * Varies about 3.3% over the year with the Earth–Sun distance.
 */
function extraterrestrialNormal(doy: number): number {
  return SOLAR_CONSTANT * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));
}

/**
 * Plane-of-array irradiance for a tilted, oriented surface, Wh/m².
 *
 * HDKR (Hay–Davies–Klucher–Reindl) sky, plus 20% ground albedo. Diffuse light
 * is not uniform across the sky: there is a bright halo around the sun and a
 * brighter band at the horizon, and a tilted array sees more of the first and
 * less of the second than a flat one.
 *
 * The previous isotropic model ignored both, which rated a 35° south-facing
 * array at roughly 0.99x a horizontal one — below the flat-roof case, and well
 * under the 1.15–1.20x PVGIS reports for the same array in Ireland. It made
 * every payback on the most common Irish installation systematically
 * pessimistic, and quietly undercut the "PVGIS-calibrated" claim.
 *
 * @param azimuthDeg Array azimuth in degrees clockwise from north (180 = south).
 * @param tiltDeg    Array tilt from horizontal in degrees.
 */
export function buildPoa(
  azimuthDeg: number,
  tiltDeg: number,
  ghi: Float32Array,
  location: LocationProfile,
): Float32Array {
  const poa = new Float32Array(HOURS_IN_YEAR);
  const tilt = tiltDeg * DEG;
  const arrayAz = azimuthDeg * DEG;
  let hourIdx = 0;
  for (let m = 0; m < 12; m += 1) {
    const days = DAYS_IN_MONTH[m] ?? 0;
    for (let d = 0; d < days; d += 1) {
      const doy = dayOfYear(m, d + 1);
      const e0 = extraterrestrialNormal(doy);
      for (let h = 0; h < 24; h += 1) {
        const ghiH = ghi[hourIdx] ?? 0;
        if (ghiH <= 0) { poa[hourIdx] = 0; hourIdx += 1; continue; }
        const pos = solarPosition(doy, h + 0.5, location.lat, location.lon);
        const sinAlt = Math.sin(pos.altitude);
        if (sinAlt <= 0.01) { poa[hourIdx] = 0; hourIdx += 1; continue; }
        // Hourly clearness index: this hour's irradiance against what a
        // cloudless sky would deliver at this sun angle. The monthly mean was
        // being fed to an hourly correlation, which is a convexity error — it
        // reports the whole year as uniformly hazy and erases every clear hour.
        const ktH = Math.max(0, Math.min(1, ghiH / Math.max(1, e0 * sinAlt)));
        const dfFracH = erbsDiffuse(ktH);
        const dni = (ghiH * (1 - dfFracH)) / Math.max(sinAlt, 0.05);
        const dhi = ghiH * dfFracH;
        const bhi = Math.max(0, ghiH - dhi);          // beam on the horizontal
        const cosTheta = Math.cos(pos.altitude) * Math.sin(tilt) * Math.cos(pos.azimuth - arrayAz)
          + Math.sin(pos.altitude) * Math.cos(tilt);
        const beamPoa = dni * Math.max(0, cosTheta);

        // Anisotropy index: the share of diffuse light behaving like beam, so
        // arriving from the sun's direction rather than uniformly.
        const ai = Math.max(0, Math.min(1, dni / e0));
        // Geometric factor, beam on the tilted plane per unit beam on the flat.
        const rb = Math.max(0, cosTheta) / Math.max(sinAlt, 0.05);
        // Horizon-brightening weight (Reindl), damped near an overcast sky.
        const f = ghiH > 0 ? Math.sqrt(Math.max(0, bhi / ghiH)) : 0;
        const halfTiltSin = Math.sin(tilt / 2);
        const diffPoa = dhi * (
          ai * rb
          + (1 - ai) * ((1 + Math.cos(tilt)) / 2) * (1 + f * halfTiltSin * halfTiltSin * halfTiltSin)
        );

        const refPoa = ghiH * 0.2 * (1 - Math.cos(tilt)) / 2;
        poa[hourIdx] = beamPoa + diffPoa + refPoa;
        hourIdx += 1;
      }
    }
  }
  return poa;
}

export interface ArraySpec {
  countPanels: number;
  /** Nameplate watts per panel. */
  panelW: number;
  /** System loss factor as a multiplier, e.g. 0.86 for 14% losses. */
  sysLoss: number;
  /** Inverter AC clipping limit, kW. */
  inverterKw: number;
}

/**
 * Hourly AC generation, kW (numerically equal to kWh for a one-hour step).
 * Applies a linear cell-temperature derate of -0.36 %/°C above 25 °C, floored
 * at 30% so an implausible profile can never drive output negative.
 */
export function buildPvGeneration(
  poa: Float32Array,
  spec: ArraySpec,
  location: LocationProfile,
): Float32Array {
  const dcKw = (spec.countPanels * spec.panelW) / 1000;
  const gen = new Float32Array(HOURS_IN_YEAR);
  let hourIdx = 0;
  for (let m = 0; m < 12; m += 1) {
    const tAmb = location.temp_c[m] ?? 0;
    const days = DAYS_IN_MONTH[m] ?? 0;
    for (let d = 0; d < days; d += 1) {
      for (let h = 0; h < 24; h += 1) {
        const irr = poa[hourIdx] ?? 0;
        if (irr <= 0) { gen[hourIdx] = 0; hourIdx += 1; continue; }
        const tCell = tAmb + (irr / 800) * 30;
        const tFactor = 1 + -0.0036 * (tCell - 25);
        let kwOut = dcKw * (irr / 1000) * Math.max(0.3, tFactor);
        if (kwOut > spec.inverterKw) kwOut = spec.inverterKw;
        kwOut *= spec.sysLoss;
        gen[hourIdx] = kwOut;
        hourIdx += 1;
      }
    }
  }
  return gen;
}

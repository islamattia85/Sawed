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
 * Hourly global horizontal irradiance for a year, Wh/m².
 * Monthly totals are distributed across daylight hours in proportion to solar
 * altitude, so the monthly energy matches the location profile exactly.
 */
export function buildHourlyGhi(location: LocationProfile): Float32Array {
  const ghi = new Float32Array(HOURS_IN_YEAR);
  let hourIdx = 0;
  for (let m = 0; m < 12; m += 1) {
    const monthlyDailyGhi = (location.ghi_kwh_m2_day[m] ?? 0) * 1000;
    const days = DAYS_IN_MONTH[m] ?? 0;
    for (let d = 0; d < days; d += 1) {
      const doy = dayOfYear(m, d + 1);
      const altitudes: number[] = [];
      for (let h = 0; h < 24; h += 1) {
        const pos = solarPosition(doy, h + 0.5, location.lat, location.lon);
        altitudes.push(Math.max(0, Math.sin(pos.altitude)));
      }
      const sumAlt = altitudes.reduce((a, b) => a + b, 0);
      for (let h = 0; h < 24; h += 1) {
        const frac = sumAlt > 0 ? (altitudes[h] ?? 0) / sumAlt : 0;
        ghi[hourIdx] = monthlyDailyGhi * frac;
        hourIdx += 1;
      }
    }
  }
  return ghi;
}

/**
 * Plane-of-array irradiance for a tilted, oriented surface, Wh/m².
 * Isotropic sky model plus 20% ground albedo.
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
    const dfFrac = erbsDiffuse(location.kt[m] ?? 0);
    const days = DAYS_IN_MONTH[m] ?? 0;
    for (let d = 0; d < days; d += 1) {
      const doy = dayOfYear(m, d + 1);
      for (let h = 0; h < 24; h += 1) {
        const ghiH = ghi[hourIdx] ?? 0;
        if (ghiH <= 0) { poa[hourIdx] = 0; hourIdx += 1; continue; }
        const pos = solarPosition(doy, h + 0.5, location.lat, location.lon);
        const sinAlt = Math.sin(pos.altitude);
        if (sinAlt <= 0.01) { poa[hourIdx] = 0; hourIdx += 1; continue; }
        const dni = (ghiH * (1 - dfFrac)) / Math.max(sinAlt, 0.05);
        const dhi = ghiH * dfFrac;
        const cosTheta = Math.cos(pos.altitude) * Math.sin(tilt) * Math.cos(pos.azimuth - arrayAz)
          + Math.sin(pos.altitude) * Math.cos(tilt);
        const beamPoa = dni * Math.max(0, cosTheta);
        const diffPoa = dhi * (1 + Math.cos(tilt)) / 2;
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

import { describe, it, expect } from 'vitest';
import {
  solarPosition, erbsDiffuse, buildHourlyGhi, buildPoa, buildPvGeneration,
} from '../../src/engine/solar.js';
import {
  LOCATION_BASE, withGhiMultiplier, dayOfYear, DEG, HOURS_IN_YEAR,
} from '../../src/engine/constants.js';

const sumOf = (a: Float32Array) => a.reduce((acc, v) => acc + v, 0);

describe('dayOfYear', () => {
  it('maps month/day to 1-365', () => {
    expect(dayOfYear(0, 1)).toBe(1);
    expect(dayOfYear(1, 1)).toBe(32);
    expect(dayOfYear(11, 31)).toBe(365);
  });
});

describe('solarPosition', () => {
  it('puts the sun below the horizon at midnight in Dublin', () => {
    const { altitude } = solarPosition(172, 0, LOCATION_BASE.lat, LOCATION_BASE.lon);
    expect(altitude).toBeLessThan(0);
  });

  it('peaks near solar noon', () => {
    const noon = solarPosition(172, 13, LOCATION_BASE.lat, LOCATION_BASE.lon).altitude;
    for (const h of [6, 9, 17, 20]) {
      expect(solarPosition(172, h, LOCATION_BASE.lat, LOCATION_BASE.lon).altitude)
        .toBeLessThan(noon);
    }
  });

  it('midsummer noon sun is higher than midwinter noon sun', () => {
    const summer = solarPosition(172, 13, LOCATION_BASE.lat, LOCATION_BASE.lon).altitude;
    const winter = solarPosition(355, 13, LOCATION_BASE.lat, LOCATION_BASE.lon).altitude;
    expect(summer).toBeGreaterThan(winter);
    // Geometry: the seasonal swing is twice the axial tilt, ~46.8°.
    expect((summer - winter) / DEG).toBeCloseTo(46.8, 0);
  });

  it('peak midsummer altitude matches the 90 - lat + declination identity', () => {
    // Scan rather than assume the hour: solar noon in Dublin is ~12:27 local
    // mean time, not 13:00, because of the equation of time and longitude.
    let peak = -Infinity;
    for (let h = 0; h < 24; h += 0.05) {
      const a = solarPosition(172, h, LOCATION_BASE.lat, LOCATION_BASE.lon).altitude / DEG;
      if (a > peak) peak = a;
    }
    expect(peak).toBeCloseTo(90 - LOCATION_BASE.lat + 23.44, 1);
  });
});

describe('erbsDiffuse', () => {
  it('is almost fully diffuse under a heavily overcast sky', () => {
    expect(erbsDiffuse(0.05)).toBeGreaterThan(0.99);
  });

  it('falls as the sky clears', () => {
    const series = [0.1, 0.3, 0.5, 0.7].map(erbsDiffuse);
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]!).toBeLessThan(series[i - 1]!);
    }
  });

  it('clamps to 0.165 for very clear skies', () => {
    expect(erbsDiffuse(0.85)).toBe(0.165);
    expect(erbsDiffuse(1.0)).toBe(0.165);
  });

  it('stays a valid fraction across the whole domain', () => {
    for (let kt = 0; kt <= 1.0001; kt += 0.02) {
      const d = erbsDiffuse(kt);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildHourlyGhi', () => {
  const ghi = buildHourlyGhi(LOCATION_BASE);

  it('returns a full year of hours', () => {
    expect(ghi.length).toBe(HOURS_IN_YEAR);
  });

  it('conserves the location profile: annual total matches monthly means', () => {
    const expected = LOCATION_BASE.ghi_kwh_m2_day
      .reduce((acc, v, m) => acc + v * 1000 * [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]!, 0);
    expect(sumOf(ghi)).toBeCloseTo(expected, 0);
  });

  it('is never negative and is zero at night', () => {
    expect(Math.min(...ghi)).toBe(0);
    // 2am on 1 January, Dublin: dark.
    expect(ghi[2]).toBe(0);
  });

  it('June has more irradiance than December', () => {
    const june = sumOf(ghi.slice(dayOfYear(5, 1) * 24, dayOfYear(6, 1) * 24));
    const dec = sumOf(ghi.slice(dayOfYear(11, 1) * 24, HOURS_IN_YEAR));
    expect(june).toBeGreaterThan(dec * 5);
  });

  it('scales linearly with a regional multiplier', () => {
    const sunnier = buildHourlyGhi(withGhiMultiplier(LOCATION_BASE, 1.1));
    expect(sumOf(sunnier)).toBeCloseTo(sumOf(ghi) * 1.1, 0);
  });
});

describe('buildPoa', () => {
  const ghi = buildHourlyGhi(LOCATION_BASE);

  /**
   * KNOWN LIMITATION - characterisation test, not an endorsement.
   *
   * The transposition uses an isotropic sky: diffuse on a tilted plane is
   * dhi * (1 + cos(tilt)) / 2, which falls monotonically with tilt and models
   * neither circumsolar brightening nor horizon brightening. Under Irish skies
   * the diffuse fraction is high (kt 0.32-0.45), so that loss swamps the beam
   * gain and the model reports peak yield at ~20 deg with a 35 deg roof coming
   * out marginally BELOW horizontal.
   *
   * PVGIS for Dublin puts the optimum near 35 deg and ~15-20% above horizontal.
   * So the engine currently understates a well-pitched roof and cannot really
   * distinguish roof pitches from each other.
   *
   * These assertions pin today's behaviour so the extraction is provably
   * faithful. Switching to Hay-Davies or Perez will fail them loudly, which is
   * exactly what should happen - it is a deliberate change to every payback
   * number in the app, not a silent one.
   */
  it('CHARACTERISATION: isotropic sky makes tilt nearly irrelevant', () => {
    const flat = sumOf(buildPoa(180, 0, ghi, LOCATION_BASE));
    const ratio = (tilt: number) => sumOf(buildPoa(180, tilt, ghi, LOCATION_BASE)) / flat;
    expect(ratio(20)).toBeCloseTo(1.015, 2);
    expect(ratio(35)).toBeCloseTo(0.988, 2);
    // The whole 0-40 deg range spans under 5% - the bug, stated as a number.
    expect(Math.abs(ratio(40) - ratio(0))).toBeLessThan(0.05);
  });

  it('still penalises steep tilts, which dominate the diffuse loss', () => {
    const flat = sumOf(buildPoa(180, 0, ghi, LOCATION_BASE));
    expect(sumOf(buildPoa(180, 70, ghi, LOCATION_BASE))).toBeLessThan(flat * 0.9);
  });

  it('south beats north at the same tilt', () => {
    const south = sumOf(buildPoa(180, 35, ghi, LOCATION_BASE));
    const north = sumOf(buildPoa(0, 35, ghi, LOCATION_BASE));
    expect(south).toBeGreaterThan(north);
  });

  it('east and west are near-symmetric about south', () => {
    const east = sumOf(buildPoa(90, 35, ghi, LOCATION_BASE));
    const west = sumOf(buildPoa(270, 35, ghi, LOCATION_BASE));
    expect(Math.abs(east - west) / east).toBeLessThan(0.02);
  });

  it('never produces negative irradiance at any orientation', () => {
    for (const az of [0, 90, 180, 270]) {
      const poa = buildPoa(az, 40, ghi, LOCATION_BASE);
      expect(Math.min(...poa)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildPvGeneration', () => {
  const ghi = buildHourlyGhi(LOCATION_BASE);
  const poa = buildPoa(180, 35, ghi, LOCATION_BASE);
  const spec = { countPanels: 12, panelW: 440, sysLoss: 0.86, inverterKw: 6 };

  it('produces a plausible Irish yield per kWp', () => {
    const annual = sumOf(buildPvGeneration(poa, spec, LOCATION_BASE));
    const kwp = (spec.countPanels * spec.panelW) / 1000;
    // Irish south-facing installs land around 850-1000 kWh/kWp/yr.
    expect(annual / kwp).toBeGreaterThan(750);
    expect(annual / kwp).toBeLessThan(1100);
  });

  it('scales with array size', () => {
    const small = sumOf(buildPvGeneration(poa, { ...spec, countPanels: 6 }, LOCATION_BASE));
    const large = sumOf(buildPvGeneration(poa, { ...spec, countPanels: 12 }, LOCATION_BASE));
    expect(large / small).toBeCloseTo(2, 1);
  });

  it('clips at the inverter limit', () => {
    const gen = buildPvGeneration(
      poa, { countPanels: 30, panelW: 440, sysLoss: 1, inverterKw: 5 }, LOCATION_BASE,
    );
    expect(Math.max(...gen)).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('never generates at night', () => {
    const gen = buildPvGeneration(poa, spec, LOCATION_BASE);
    // 1 January, 00:00-04:00.
    for (let h = 0; h < 4; h += 1) expect(gen[h]).toBe(0);
  });

  it('is never negative even with an implausibly hot profile', () => {
    const scorching = { ...LOCATION_BASE, temp_c: LOCATION_BASE.temp_c.map(() => 60) };
    const gen = buildPvGeneration(poa, spec, scorching);
    expect(Math.min(...gen)).toBeGreaterThanOrEqual(0);
  });

  it('hot weather reduces output relative to cool weather', () => {
    const cool = { ...LOCATION_BASE, temp_c: LOCATION_BASE.temp_c.map(() => 5) };
    const hot = { ...LOCATION_BASE, temp_c: LOCATION_BASE.temp_c.map(() => 35) };
    expect(sumOf(buildPvGeneration(poa, spec, hot)))
      .toBeLessThan(sumOf(buildPvGeneration(poa, spec, cool)));
  });
});

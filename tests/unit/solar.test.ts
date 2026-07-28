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
   * the sky is not uniform. There is a bright halo around the sun and a
   * brighter band at the horizon, and a tilted array sees more of the first and
   * less of the second than a flat one.
   *
   * Two errors used to combine here. The sky model was isotropic, ignoring both
   * effects; and Erbs — an hourly correlation between clearness and diffuse
   * fraction — was being fed the month's MEAN clearness, which is a convexity
   * error. Averaging the weather away removes every clear hour from the year,
   * so the model saw a permanently hazy sky, put the diffuse fraction near 0.8
   * all year, and reported a 35 deg roof as marginally WORSE than horizontal.
   *
   * The engine now varies clearness day to day (monthly totals unchanged),
   * derives the clearness index per hour, and transposes with HDKR. PVGIS puts
   * a 35 deg south-facing array in Dublin 15-20% above horizontal, with the
   * optimum near 35 deg. These assertions hold the model inside that band.
   */
  it('a well-pitched south roof beats horizontal by the margin PVGIS reports', () => {
    const flat = sumOf(buildPoa(180, 0, ghi, LOCATION_BASE));
    const ratio = (tilt: number) => sumOf(buildPoa(180, tilt, ghi, LOCATION_BASE)) / flat;
    expect(ratio(35)).toBeGreaterThan(1.13);
    expect(ratio(35)).toBeLessThan(1.22);
    // The optimum is a roof pitch, not a flat roof.
    const best = [0, 10, 20, 30, 35, 40, 50, 60]
      .reduce((a, t) => (ratio(t) > ratio(a) ? t : a), 0);
    expect(best).toBeGreaterThanOrEqual(30);
    expect(best).toBeLessThanOrEqual(45);
    // And pitch now matters: the 0-40 deg range spans far more than the 5%
    // the isotropic model produced.
    expect(ratio(40) - ratio(0)).toBeGreaterThan(0.1);
  });

  it('orientation matters as much as pitch', () => {
    const at = (az: number) => sumOf(buildPoa(az, 35, ghi, LOCATION_BASE));
    // East and west are meaningfully worse than south, not a rounding error.
    expect(at(90) / at(180)).toBeLessThan(0.9);
    expect(at(135) / at(180)).toBeGreaterThan(0.9);
  });

  it('penalises tilts past the optimum, and a wall most of all', () => {
    const flat = sumOf(buildPoa(180, 0, ghi, LOCATION_BASE));
    const at = (t: number) => sumOf(buildPoa(180, t, ghi, LOCATION_BASE));
    // Past the optimum, more pitch costs yield.
    expect(at(70)).toBeLessThan(at(40));
    expect(at(90)).toBeLessThan(at(70));
    // Vertical is worse than flat. Steep-but-not-vertical is not: at 53°N the
    // sun is low for much of the year, and the isotropic model's claim that a
    // 70° array underperforms a flat one was an artefact, not physics.
    expect(at(90)).toBeLessThan(flat);
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

describe('no day receives more sun than the sky can deliver', () => {
  const ghi = buildHourlyGhi(LOCATION_BASE);
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const SOLAR_CONSTANT = 1367;

  /** Extraterrestrial energy on the horizontal for one day, Wh/m². */
  const clearSky = (doy: number) => {
    const e0 = SOLAR_CONSTANT * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));
    let t = 0;
    for (let h = 0; h < 24; h += 1) {
      const pos = solarPosition(doy, h + 0.5, LOCATION_BASE.lat, LOCATION_BASE.lon);
      t += Math.max(0, Math.sin(pos.altitude)) * e0;
    }
    return t;
  };

  /**
   * The clearness index is the share of extraterrestrial irradiance that
   * reaches the ground. It cannot exceed about 0.75 at Irish latitudes, and a
   * daily figure above 0.8 is not a sunny day — it is a broken model.
   *
   * The per-day clearness weights spread a month's energy across its days, and
   * nothing checked the answer against that ceiling. On a 5.3 kWp array the
   * brightest day came out at 40.3 kWh, 7.64 kWh per kWp, when Ireland's best
   * is about 6.5. Someone scrubbing the day inspector was being shown a day
   * that cannot happen.
   */
  it('daily clearness index never exceeds the physical limit', () => {
    let day = 0;
    const offenders: string[] = [];
    for (let m = 0; m < 12; m += 1) {
      for (let d = 0; d < (DIM[m] ?? 0); d += 1) {
        let dayGhi = 0;
        for (let h = 0; h < 24; h += 1) dayGhi += ghi[day * 24 + h] ?? 0;
        const cs = clearSky(day + 1);
        const kt = cs > 0 ? dayGhi / cs : 0;
        if (kt > 0.78) offenders.push(`day ${day + 1}: kt=${kt.toFixed(3)}`);
        day += 1;
      }
    }
    expect(offenders, `days above the clear-sky ceiling: ${offenders.slice(0, 5).join(', ')}`)
      .toEqual([]);
  });

  it('still matches the location’s monthly totals exactly', () => {
    // Capping a day has to move its surplus to other days, not delete it.
    let day = 0;
    for (let m = 0; m < 12; m += 1) {
      let monthly = 0;
      for (let d = 0; d < (DIM[m] ?? 0); d += 1) {
        for (let h = 0; h < 24; h += 1) monthly += ghi[day * 24 + h] ?? 0;
        day += 1;
      }
      const expected = (LOCATION_BASE.ghi_kwh_m2_day[m] ?? 0) * 1000 * (DIM[m] ?? 0);
      expect(monthly / expected, `month ${m + 1} total drifted`).toBeCloseTo(1, 2);
    }
  });

  it('days still differ from one another', () => {
    // The cap must not flatten the month into an average, which is the thing
    // the weights were added to avoid.
    const june: number[] = [];
    for (let d = 151; d < 181; d += 1) {
      let t = 0;
      for (let h = 0; h < 24; h += 1) t += ghi[d * 24 + h] ?? 0;
      june.push(t);
    }
    const mean = june.reduce((a, b) => a + b, 0) / june.length;
    expect(Math.min(...june) / mean, 'every June day is the same').toBeLessThan(0.8);
    expect(Math.max(...june) / mean).toBeGreaterThan(1.2);
  });
});


import { describe, it, expect } from 'vitest';
import { setState, fileOwnShape, shapeBuckets, getShape } from '../../src/model.js';

// A home's own day: more in the evening than anywhere else. After its panels
// and battery go up, the meter shows what it bought: nothing in the day, the
// battery's leftovers bought at night.
const own = [...[0.3, 0.3, 0.3, 0.3, 0.3, 0.3], ...[0.6, 0.8, 0.6, 0.4], ...new Array(7).fill(0.5), ...[1.5, 1.8, 1.6, 1.2, 0.8], 0.5, 0.4];
const bought = [...new Array(6).fill(0.9), ...new Array(4).fill(0.3), ...new Array(7).fill(0), ...new Array(5).fill(0.2), 0.8, 0.9];
const sold = [...new Array(10).fill(0), ...new Array(7).fill(1.2), ...new Array(7).fill(0)];
const year = (panelsFrom: number) => {
  const days: Record<string, number[]> = {};
  for (let i = 0; i < 365; i++) {
    const k = new Date(Date.UTC(2025, 9, 9 + i)).toISOString().slice(0, 10);
    days[k] = i < panelsFrom ? [...own, ...new Array(24).fill(0)] : [...bought, ...sold];
  }
  return days;
};
const home = { _csv_imported: true, heating_type: 'heatpump', has_solar: true, solar_planned: false, count_A: 13, count_B: 0,
  battery_kwh: 10, panel_w: 460, azimuth_A: 180, tilt_A: 35 };
const night = (shape: number[]) => [22, 23, 0, 1, 2, 3, 4, 5].reduce((a, h) => a + shape[h]!, 0) / shape.reduce((a, b) => a + b, 0);

describe("a home's own hours from a meter file with panels in it", () => {
  it('splits a day into four parts adding to 100', () => {
    const p = shapeBuckets(own)!;
    expect(p.night + p.morning + p.day + p.evening).toBe(100);
  });

  it('comes from the days before the panels when there are three weeks of them', () => {
    setState({ ...home, meter: { days: year(60) }, file_when: 'sinceyes', _shape_buckets: shapeBuckets(bought) });
    const s = fileOwnShape()!;
    expect(s.buckets).toEqual(shapeBuckets(own));
    expect(s.hourly![18]).toBeCloseTo(1.8 / own.reduce((a, b) => a + b, 0), 6);
  });

  it('is the heating profile, not what the meter bought, when the panels were up all along', () => {
    setState({ ...home, meter: { days: year(0) }, file_when: 'allyear', _shape_buckets: shapeBuckets(bought) });
    expect(fileOwnShape()).toEqual({ hourly: null, buckets: null });
    // The bought pattern puts most of the day in the night; the heat pump profile does not.
    expect(night(bought)).toBeGreaterThan(0.5);
    expect(night(getShape(0))).toBeLessThan(0.4);
  });

  it('leaves a file with no panels in it to its own pattern', () => {
    setState({ _csv_imported: true, heating_type: 'gas', has_solar: false, meter: { days: year(365) }, _shape_buckets: shapeBuckets(own) });
    expect(fileOwnShape()).toBeNull();
  });

  it('keeps a pattern set by hand', () => {
    const mine = { night: 50, morning: 10, day: 10, evening: 30 };
    setState({ ...home, meter: { days: year(0) }, file_when: 'allyear', _shape_buckets: mine, _shape_user: true });
    expect(night(getShape(0))).toBeCloseTo(0.5, 2);
  });
});

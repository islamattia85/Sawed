import { describe, it, expect } from 'vitest';
import { setState, meterYearDays } from '../../src/model.js';

// A year of readings, 6 Oct 2025 to 5 Oct 2026: weekdays use 1 kWh an hour,
// weekends 2, so a day laid on the wrong weekday shows at once.
const days: Record<string, number[]> = {};
for (let i = 0; i < 365; i++) {
  const d = new Date(Date.UTC(2025, 9, 6 + i));
  const we = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  days[d.toISOString().slice(0, 10)] = [...new Array(24).fill(we ? 2 : 1), ...new Array(24).fill(0)];
}

describe('a year of meter readings is priced day by day', () => {
  it('lays each recorded day on the same weekday of the model year', () => {
    setState({ _csv_imported: true, meter: { days } });
    const out = meterYearDays()!;
    expect(out).not.toBeNull();
    for (let doy = 0; doy < 365; doy++) {
      const dow = new Date(Date.UTC(2025, 0, 1 + doy)).getUTCDay();
      expect(out[doy][0]).toBe(dow === 0 || dow === 6 ? 2 : 1);
    }
  });
  it('is used with panels already on the roof (the file is net of them), not with too few days', () => {
    setState({ _csv_imported: true, meter: { days }, has_solar: true, solar_planned: false });
    expect(meterYearDays()).not.toBeNull();
    const few = Object.fromEntries(Object.entries(days).slice(0, 200));
    setState({ _csv_imported: true, meter: { days: few } });
    expect(meterYearDays()).toBeNull();
  });
});

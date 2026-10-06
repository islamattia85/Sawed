import { describe, it, expect } from 'vitest';
import { setState, batteryReplacement, batterySwapYear } from '../../src/model.js';

describe('replacing a battery within 20 years', () => {
  it('lasts 15 years; the share of a new one used to year 20 is charged at a falling price', () => {
    setState({});
    expect(batterySwapYear()).toBe(15);
    // 10 kWh: 400 x 0.97^15 x 10 = EUR 2,533, a third of it used by year 20.
    expect(Math.round(batteryReplacement(10))).toBe(844);
    expect(batteryReplacement(10, 0.03)).toBeLessThan(batteryReplacement(10));
    expect(batteryReplacement(0)).toBe(0);
  });
  it('costs nothing within 20 years when the battery lasts 20', () => {
    setState({ battery_life_years: 20 });
    expect(batteryReplacement(10)).toBe(0);
    expect(batterySwapYear()).toBe(0);
  });
});

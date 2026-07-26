import { describe, it, expect } from 'vitest';
import {
  kwh, kw, eur, cent, ratio,
  centToEur, eurToCent,
  kwhOverHoursToKw, kwForHoursToKwh,
  bimonthlyToAnnual, annualToBimonthly,
  BILLING_PERIODS_PER_YEAR,
} from '../../src/engine/units.js';

describe('unit conversions', () => {
  it('cents and euro round-trip', () => {
    expect(centToEur(cent(35.16))).toBeCloseTo(0.3516, 6);
    expect(eurToCent(eur(12.5))).toBeCloseTo(1250, 6);
  });

  it('half-hourly energy converts to average power', () => {
    // The Day Inspector bug: a 0.34 kWh half-hour reading is 0.68 kW.
    expect(kwhOverHoursToKw(kwh(0.34), 0.5)).toBeCloseTo(0.68, 6);
    // An hourly reading is numerically equal to average power.
    expect(kwhOverHoursToKw(kwh(0.34), 1)).toBeCloseTo(0.34, 6);
  });

  it('power sustained over time converts back to energy', () => {
    expect(kwForHoursToKwh(kw(0.68), 0.5)).toBeCloseTo(0.34, 6);
    const roundTrip = kwhOverHoursToKw(kwForHoursToKwh(kw(2.4), 0.5), 0.5);
    expect(roundTrip).toBeCloseTo(2.4, 6);
  });

  it('Irish billing is six periods a year', () => {
    expect(BILLING_PERIODS_PER_YEAR).toBe(6);
    expect(bimonthlyToAnnual(eur(250))).toBeCloseTo(1500, 6);
    expect(annualToBimonthly(eur(1500))).toBeCloseTo(250, 6);
  });

  it('bimonthly/annual round-trips', () => {
    expect(annualToBimonthly(bimonthlyToAnnual(eur(187.5)))).toBeCloseTo(187.5, 6);
  });

  it('brands erase at runtime', () => {
    // Branding must cost nothing: the value is the same primitive.
    expect(kwh(4200)).toBe(4200);
    expect(ratio(0.9) + 0.1).toBeCloseTo(1.0, 6);
    expect(typeof eur(10)).toBe('number');
  });
});

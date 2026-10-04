import { describe, it, expect } from 'vitest';
import { gasYear, gasKwhFromBill, dualFuelChoices, inFirstYear, GAS_CARBON_TAX, supplierKey } from '../../src/gas.js';

const AS_OF = new Date('2026-10-04T12:00:00Z');
const BG = { supplier: 'Bord Gáis Energy', unit: 0.10, standing: 140, dual_discount: 0.29, dual_welcome: 200, readable: true };
const FL = { supplier: 'Flogas', unit: 0.11, standing: 130, dual_discount: 0.2, dual_welcome: 300, readable: true };
const EN = { supplier: 'Energia', unit: 0.115, standing: 129.91, dual_discount: 0.15, dual_welcome: 0, readable: false };

describe('gas', () => {
  it('a year is kWh × (unit after discount + carbon tax) + standing', () => {
    expect(gasYear(BG, 11000, 0, AS_OF)).toBeCloseTo(11000 * (0.10 + GAS_CARBON_TAX) + 140, 6);
    expect(gasYear(BG, 11000, 0.29, AS_OF)).toBeCloseTo(11000 * (0.071 + GAS_CARBON_TAX) + 140, 6);
  });
  it('an announced rise counts for the part of the year after it', () => {
    const g = { ...BG, price_change: { effective_date: '2026-10-09', pct: 0.1, standing_pct: 0 } };
    const w = (365 - 4.5) / 365;
    expect(gasYear(g, 10000, 0, AS_OF)).toBeCloseTo(10000 * (0.10 * (1 + w * 0.1) + GAS_CARBON_TAX) + 140, 4);
  });
  it('kWh from the bill round-trips through a year of gas', () => {
    const kwh = gasKwhFromBill(250, BG, 0.29, AS_OF);
    expect(gasYear(BG, kwh, 0.29, AS_OF)).toBeCloseTo(1500, -1);
  });
  it('first year is read from the contract end date', () => {
    expect(inFirstYear('2027-03-01', AS_OF)).toBe(true);
    expect(inFirstYear('2026-01-01', AS_OF)).toBe(false);
    expect(inFirstYear('', AS_OF)).toBe(false);
  });
  it('supplier names match however they are written', () => {
    expect(supplierKey('Bord Gáis')).toBe(supplierKey('Bord Gáis Energy'));
    expect(supplierKey('SSE Airtricity')).toBe(supplierKey('SSE'));
  });
});

describe('dual-fuel choices', () => {
  const elec = {
    baseline: 1500, cheapest: { supplier: 'SSE Airtricity', net: 1400 },
    bestBySupplier: new Map([[supplierKey('Flogas'), { plan: { id: 'FL' }, net: 1450 }], [supplierKey('Energia'), { plan: { id: 'EN' }, net: 1380 }]]),
  };
  it('in the first year, moving only the electricity costs the gas discount', () => {
    const c = dualFuelChoices(elec, { supplier: 'Bord Gáis', kwh: 11000, firstYear: true }, [BG, FL, EN], AS_OF)!;
    expect(c.moveElec!.lost).toBeCloseTo(11000 * 0.10 * 0.29, 4);
    expect(c.moveElec!.total - c.stay.total).toBeCloseTo(-100 + 11000 * 0.10 * 0.29, 4);
  });
  it('past the first year, there is no discount left to lose', () => {
    const c = dualFuelChoices(elec, { supplier: 'Bord Gáis', kwh: 11000, firstYear: false }, [BG, FL, EN], AS_OF)!;
    expect(c.moveElec!.lost).toBe(0);
  });
  it('moving both picks the cheapest readable supplier, credit beside the total', () => {
    const c = dualFuelChoices(elec, { supplier: 'Bord Gáis', kwh: 11000, firstYear: false }, [BG, FL, EN], AS_OF)!;
    expect(c.moveBoth!.supplier).toBe('Flogas');          // Energia is not readable, so not offered
    expect(c.moveBoth!.credit).toBe(300);
    expect(c.moveBoth!.total).toBeCloseTo(1450 + gasYear(FL, 11000, 0.2, AS_OF), 6);
  });
  it('no gas plan or no usage: no answer rather than a wrong one', () => {
    expect(dualFuelChoices(elec, { supplier: 'Pinergy', kwh: 11000, firstYear: false }, [BG], AS_OF)).toBeNull();
    expect(dualFuelChoices(elec, { supplier: 'Bord Gáis', kwh: 0, firstYear: false }, [BG], AS_OF)).toBeNull();
  });
});

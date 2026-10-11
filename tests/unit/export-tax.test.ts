import { describe, it, expect } from 'vitest';
import { setState, exportTax, calcSeaiGrant } from '../../src/model.js';

describe('tax on export income (Budget 2027)', () => {
  it('is free up to EUR 600 a person, then taxed at the person’s rate', () => {
    setState({});
    expect(exportTax(500)).toBe(0);
    expect(exportTax(1000)).toBeCloseTo(400 * 0.27);
    setState({ export_tax_rate: 'higher' });
    expect(exportTax(1000)).toBeCloseTo(400 * 0.47);
    setState({ export_tax_rate: 'higher', bill_names: 2 });
    expect(exportTax(1000)).toBe(0);
    setState({ export_tax_rate: 'none' });
    expect(exportTax(5000)).toBe(0);
  });
  it('a battery adds the EUR 600 battery grant to the solar grant', () => {
    setState({});
    expect(calcSeaiGrant(4, 0).total).toBe(1800);
    expect(calcSeaiGrant(4, 10).total).toBe(2400);
  });
  it('the solar grant is SEAI’s 2026 rate: €700 a kWp to 2 kWp, €200 a kWp to 4, at most €1,800', () => {
    // The app gave €900 a kWp, €400 too much on a 2 kWp system (11 Oct 2026).
    setState({});
    expect(calcSeaiGrant(1, 0).panels).toBe(700);
    expect(calcSeaiGrant(2, 0).panels).toBe(1400);
    expect(calcSeaiGrant(3, 0).panels).toBe(1600);
    expect(calcSeaiGrant(4.6, 0).panels).toBe(1800);
    expect(calcSeaiGrant(9, 0).panels).toBe(1800);
  });
});

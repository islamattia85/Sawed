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
});

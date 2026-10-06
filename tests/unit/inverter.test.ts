import { describe, it, expect } from 'vitest';
import { inverterFor } from '../../src/model.js';

describe('the inverter a suggested system gets', () => {
  it('is about 1.2 kWp of panels per kW, between 3 and 6 kW', () => {
    expect(inverterFor(2.6)).toBe(3);
    expect(inverterFor(5.3)).toBe(4.4);
    expect(inverterFor(7.0)).toBe(5.8);
    expect(inverterFor(8.8)).toBe(6);
    expect(inverterFor(15)).toBe(6);
  });
});

import { describe, it, expect } from 'vitest';
import { setState, pathValue } from '../../src/model.js';

describe('twenty years when prices move', () => {
  it('blends today into the future over the years given, then holds', () => {
    setState({});
    const now = pathValue(1000, 1000, 0, 6000, 0);
    const soon = pathValue(1000, 500, 0, 6000, 0);
    const slow = pathValue(1000, 500, 10, 6000, 0);
    expect(now.payback).toBeCloseTo(6.1, 1);
    expect(soon.value).toBeLessThan(slow.value);   // a cut straight away costs more than one over ten years
    expect(slow.value).toBeLessThan(now.value);
    expect(pathValue(100, 100, 0, 6000, 0).payback).toBeNull();
  });
});

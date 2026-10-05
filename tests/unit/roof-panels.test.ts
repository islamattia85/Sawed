import { describe, it, expect } from 'vitest';
import { state, setState, goalPanels } from '../../src/model.js';

setState({});
describe('panel sizes tried for a house', () => {
  it('a semi with one face stops at 14, with two faces at 26', () => {
    state.house_type = 'semi'; state.count_A = 10; state.count_B = 0;
    expect(Math.max(...goalPanels())).toBe(14);
    state.count_A = 7; state.count_B = 7;
    expect(Math.max(...goalPanels())).toBe(26);
  });
  it('a terraced house never goes past 10 on one face', () => {
    state.house_type = 'terraced'; state.count_B = 0;
    expect(goalPanels().every((p) => p <= 10)).toBe(true);
  });
});

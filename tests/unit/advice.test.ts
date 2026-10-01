import { describe, it, expect } from 'vitest';
import { checkSummary, AdviceSchema } from '../../api/_advice.js';

describe('advice request', () => {
  it('accepts a plain household summary', () => {
    expect(checkSummary({ summary: { home: { kwh_year: 4200 }, score: 70 } })).toBeNull();
  });
  it('refuses a summary carrying personal details, or none at all', () => {
    expect(checkSummary({ summary: { email: 'a@b.ie' } })).toMatch(/personal/);
    expect(checkSummary({ summary: { mprn: '1000' } })).toMatch(/personal/);
    expect(checkSummary({})).toMatch(/No summary/);
  });
  it('allows at most three suggestions, each with an effort level', () => {
    const item = { title: 't', why: 'w', saving_eur: null, effort: 'easy' };
    expect(AdviceSchema.safeParse({ items: [item, item, item] }).success).toBe(true);
    expect(AdviceSchema.safeParse({ items: [item, item, item, item] }).success).toBe(false);
    expect(AdviceSchema.safeParse({ items: [{ ...item, effort: 'huge' }] }).success).toBe(false);
  });
});

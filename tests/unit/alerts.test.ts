import { describe, it, expect } from 'vitest';
import { alertsFor } from '../../api/_alerts.js';

const plan = { id: 'BG-24', supplier: 'Bord Gáis Energy', plan: 'Smart All Day', price_change:
  { effective_date: '2026-10-20', pct: 0.091, direction: 'increase', note: 'Unit rates +9.1%.' } };
const home = { alerts_email: true, onboarding_complete: true, baseline: 'BG-24' };

describe('alert emails', () => {
  it('sends nothing to a household that did not opt in', () => {
    expect(alertsFor({ ...home, alerts_email: false }, [plan], '2026-10-05')).toEqual([]);
  });

  it('warns three weeks ahead of a price change on their plan, and on the day', () => {
    const ahead = alertsFor(home, [plan], '2026-10-05');
    expect(ahead.map((a) => a.key)).toEqual(['price:BG-24:2026-10-20:ahead']);
    expect(ahead[0]!.text).toMatch(/by up to 9%/);
    expect(alertsFor(home, [plan], '2026-10-20').map((a) => a.key)).toEqual(['price:BG-24:2026-10-20:day']);
    expect(alertsFor(home, [plan], '2026-09-01')).toEqual([]);
  });

  it('ignores price changes on plans the household is not on', () => {
    expect(alertsFor({ ...home, baseline: 'EN-24' }, [plan], '2026-10-05')).toEqual([]);
  });

  it('reminds a month and a week before the contract ends, under distinct keys', () => {
    const s = { ...home, baseline: 'X', contract_end: '2026-11-30' };
    expect(alertsFor(s, [], '2026-11-05').map((a) => a.key)).toEqual(['contract:2026-11-30:30']);
    expect(alertsFor(s, [], '2026-11-26').map((a) => a.key)).toEqual(['contract:2026-11-30:7']);
    expect(alertsFor(s, [], '2026-12-05')).toEqual([]);
  });
});

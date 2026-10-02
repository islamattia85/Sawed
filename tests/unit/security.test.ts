import { describe, it, expect } from 'vitest';
import { originAllowed } from '../../api/_server.js';
import { validateLead } from '../../api/_lead.js';

describe('who may call the server functions', () => {
  it('lets the app in, and nobody else on Vercel', () => {
    expect(originAllowed('https://peakless-beta.vercel.app')).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('https://someone-else.vercel.app')).toBe(false);
    expect(originAllowed('https://peakless-beta.vercel.app.evil.com')).toBe(false);
  });
  it('refuses a call with no Origin: browsers always send one', () => {
    expect(originAllowed('')).toBe(false);
  });
});

describe('a quote request cannot carry database syntax', () => {
  const ok = { county: 'Cork', consent_share: true };
  it.each(['a@b.ie,phone.neq.0', 'a@b.ie)', 'x"@b.ie', 'a b@c.ie', 'a@b.ie;--'])('refuses %s', (email) => {
    expect(validateLead({ ...ok, email }).error).toMatch(/email/);
  });
  it('still takes ordinary addresses', () => {
    for (const email of ['mary.o-brien+solar@eir.ie', 'Home@Example.co.uk']) expect(validateLead({ ...ok, email }).lead).toBeTruthy();
  });
});

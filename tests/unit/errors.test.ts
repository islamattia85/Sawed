import { describe, it, expect } from 'vitest';
import { scrub, buildReport } from '../../src/errors';

describe('error reports carry what broke, never who', () => {
  it('scrubs emails, long numbers, query strings and hosts', () => {
    const s = scrub('Failed for mary@eir.ie MPRN 10012345678 at https://peakless.app/x.js?token=abc:12:4');
    expect(s).not.toMatch(/mary|eir\.ie|10012345678|token|peakless\.app/);
    expect(s).toContain('[email]');
    expect(s).toContain('/x.js');
  });
  it('builds a short report from an Error', () => {
    const r = buildReport(new TypeError('x is undefined'), { build: 'abc123', version: '8.0.0', screen: 'solar' });
    expect(r.message).toBe('x is undefined');
    expect(r.stack).toMatch(/TypeError/);
    expect(r.screen).toBe('solar');
    expect(r.message.length).toBeLessThanOrEqual(300);
    expect(r.stack.length).toBeLessThanOrEqual(2000);
  });
  it('copes with a thrown string or nothing', () => {
    expect(buildReport('boom', { build: '', version: '', screen: '' }).message).toBe('boom');
    expect(buildReport(undefined, { build: '', version: '', screen: '' }).message).toBe('undefined');
  });
});

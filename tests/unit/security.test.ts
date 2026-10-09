import { describe, it, expect } from 'vitest';
import { originAllowed } from '../../api/_server.js';
import eventHandler, { EVENT_NAMES } from '../../api/event.js';

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

function call(handler: any, req: any) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const res: any = { status(c: number) { this.c = c; return this; }, json(b: any) { resolve({ status: this.c, body: b }); } };
    handler({ ...req, headers: { origin: 'http://localhost:5173', ...req.headers } }, res);
  });
}

describe('usage events', () => {
  it('only known event names are counted', async () => {
    expect((await call(eventHandler, { method: 'POST', body: { name: 'anything' } })).status).toBe(400);
  });
  it('none of them is about quote requests', () => {
    expect(EVENT_NAMES.some((n: string) => /lead/.test(n))).toBe(false);
  });
});

import { test, expect } from '@playwright/test';
import { boot } from './support.js';

test('an ESB file\'s half hours land in the hour they belong to (stamps are end of interval)', async ({ page }) => {
  await boot(page, { current_screen: 'updates' });
  await page.evaluate(() => window.v7Sheet('meter'));
  // 1 kW only between 02:00 and 05:00: stamps 02:30 .. 05:00.
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  for (let d = 1; d <= 28; d++) for (let m = 30; m <= 1440; m += 30) {
    const hh = Math.floor((m % 1440) / 60), mm = m % 60, day = m === 1440 ? d + 1 : d;
    const on = m > 120 && m <= 300;
    rows.push(`1,2,${on ? 1 : 0},Active Import Interval (kW),${String(day).padStart(2, '0')}-09-2026 ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  await page.locator('#csv-file-input').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await page.waitForTimeout(500);
  const shape = await page.evaluate(() => window.state._csv_hourly_shape);
  const ledger = await page.evaluate(() => { const d = window.state.meter && window.state.meter.days; const k = d && Object.keys(d).sort()[3]; return k ? d[k].slice(0, 24) : null; });
  expect(ledger.slice(2, 5).every((v) => v > 0.4)).toBe(true);
  expect(ledger[1] + ledger[5]).toBe(0);
  // The hourly shape the simulation uses: all of it in hours 2, 3 and 4.
  expect(shape[2] + shape[3] + shape[4]).toBeCloseTo(1, 5);
  expect(shape[1]).toBe(0); expect(shape[5]).toBe(0);
});

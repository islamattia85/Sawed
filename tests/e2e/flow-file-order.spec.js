import { test, expect } from '@playwright/test';

/**
 * Setup with a meter file: the file's questions follow its upload together
 * (whether the home has panels, then what the file shows about them), and
 * changing an answer part-way asks again exactly what it now needs. A tester
 * found the file's questions scattered through setup; this holds the order
 * and the logic around it.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isolate } from './support.js';
const DIR = new URL('../fixtures/meter-scenarios/files/', import.meta.url).pathname;
// The question setup shows now.
const shown = (page) => page.evaluate(() => {
  const o = document.querySelector('.fl-q [data-q]'); if (o) return o.dataset.q;
  const own = document.querySelector('.fl-q [id^=flow-own-]'); if (own) return own.id.slice(9);
  if (document.querySelector('.fl-sups, .fl-sup')) return 'plan';
  return null;
});
test('a meter file: its questions come together, and changing answers part-way asks what applies', async ({ page }) => {
  test.setTimeout(120000);
  await isolate(page);
  await page.goto('/?fresh'); await page.waitForFunction(() => window.__bootSettled === true);
  await page.evaluate(() => { localStorage.setItem('sawed_analytics', 'no'); window.startFlow('full'); });
  await page.locator('.fl-upload input[type=file]').first().setInputFiles({ name: 'B3_friend.csv', mimeType: 'text/csv', buffer: gunzipSync(readFileSync(DIR + 'B3_friend.csv.gz')) });
  await page.getByRole('button', { name: /use this data/i }).click();
  const log = [];
  const say = async (q, v) => { await page.evaluate(([q, v]) => window.flowAnswer(q, v), [q, v]); await page.waitForTimeout(150); const s = await shown(page); log.push(`${q}=${v} -> ${s}`); return s; };
  const edit = async (q, v) => { await page.evaluate((q) => window.flowEdit(q), q); return say(q, v); };
  log.push('after upload -> ' + await shown(page));
  expect(await shown(page)).toBe('solar');
  expect(await say('solar', 'have')).toBe('filewhen');
  expect(await say('filewhen', 'allyear')).toBe('meter');
  for (const [q, v] of [['meter', 'smart'], ['area', 'urban'], ['plan', 'EI-24'], ['disc', 0]]) await say(q, v);
  expect(await say('heat', 'heatpump')).toBe('heattime');
  expect(await say('heattime', 'day')).toBe('hotwater');
  await say('hotwater', 'night');
  expect(await page.evaluate(() => window.state.hot_water_strategy)).toBe('smart');
  // Heating changed to gas: its hours and hot water no longer apply; the gas question does.
  expect(await edit('heat', 'gas')).toBe('gas');
  expect(await page.evaluate(() => window.state.hot_water_strategy)).toBe('none');
  await say('gas', 'no');
  // Back to a heat pump: both asked again, hot water included.
  expect(await edit('heat', 'heatpump')).toBe('heattime');
  expect(await say('heattime', 'night')).toBe('hotwater');
  await say('hotwater', 'day');
  expect(await page.evaluate(() => window.state.hot_water_strategy)).toBe('none');
  // Solar changed to "thinking" and back: the panel-date answer stands; the roof questions are asked again.
  await edit('solar', 'thinking');
  const back = await edit('solar', 'have');
  expect(await page.evaluate(() => window.state.file_when)).toBe('allyear');
  expect(back).not.toBe('filewhen');
});

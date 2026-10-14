// @ts-check
import { test, expect } from '@playwright/test';
import { boot, esbKwFile as esbFile, uploadMeterFile as upload } from './support.js';

/*
 * Someone sets up with an ESB file from before their panels, then later
 * replaces it with a new one that has the panels in it. The figures came out
 * right, but what they had said about the old file ("from before the panels")
 * stayed, the new file's question was left as a to-do, and the figures were
 * marked less sure than they were (14 Oct 2026). A new file now clears the old
 * answer, and the upload card asks about the panels there and then.
 */
const HOME = { current_screen: 'updates', region: 'south', heating_type: 'heatpump', usage_input_mode: 'kwh', annual_kwh: 5500,
  baseline: 'EN-EV', baseline_known: true, meter_type: 'smart', has_solar: true, considering_solar: true, solar_planned: false,
  solar_is_estimate: false, count_A: 10, azimuth_A: 157, tilt_A: 35, count_B: 0, panel_w: 460, battery_kwh: 9,
  install_cost: 10000, cost_is_manual: true, grant_eligible: false, grant_seai: 0, ev_active: false, ev_in_bill: false };

const PANELS = '2026-06-19';

test('a newer file with the panels in it: the card asks about them, and the old answer is not carried over', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page, HOME);
  // Set up with a year from before the panels, said to be from before them.
  await upload(page, 'HDF_kW_old.csv', esbFile('2026-05-26', 400));
  await page.getByRole('button', { name: /Yes, use this data/ }).click();
  await page.evaluate(() => { window.state.file_when = 'before'; window.saveState(); });
  // Then the new file, panels from 19 June.
  await upload(page, 'HDF_kW_new.csv', esbFile('2026-10-13', 400, PANELS));
  expect(await page.evaluate(() => window.state.file_when), 'the old file\'s answer is gone').toBeUndefined();
  const ask = page.locator('#csv-parse-result [data-ask="since"]');
  await expect(ask).toContainText('Did your panels go in around 19 Jun 2026?');
  await ask.getByRole('button', { name: 'Yes, around then' }).click();
  expect(await page.evaluate(() => [window.state.file_when, window.fileBasis().ask])).toEqual(['sinceyes', null]);
  await page.getByRole('button', { name: /Yes, use this data/ }).click();
  await page.evaluate(() => { window.state._sheet = null; window.setScreen('updates'); });
  await expect(page.locator('.screen')).not.toContainText('Say when the panels went up');
  expect(errors).toEqual([]);
});

test('"No, a home I lived in before" puts the old answer back', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, HOME);
  await upload(page, 'HDF_kW_old.csv', esbFile('2026-05-26', 400));
  await page.getByRole('button', { name: /Yes, use this data/ }).click();
  await page.evaluate(() => { window.state.file_when = 'before'; window.saveState(); });
  await upload(page, 'HDF_kW_new.csv', esbFile('2026-10-13', 400, PANELS));
  await page.getByRole('button', { name: /No, a home I lived in before/ }).click();
  expect(await page.evaluate(() => window.state.file_when)).toBe('before');
});

test('in setup the card leaves the question to setup, which asks it in turn', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, { ...HOME, current_screen: 'flow', _flow: { solar: 'have' } });
  // Setup's own file step: its card is on the bill question.
  await page.evaluate((text) => window.parseCsvHdf(text, 'HDF_kW_new.csv'), esbFile('2026-10-13', 400, PANELS));
  await expect(page.locator('#csv-parse-result')).toContainText('Imported', { timeout: 30000 });
  await expect(page.locator('#csv-parse-result [data-ask="since"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.fileBasis().ask), 'setup still has it to ask').toBe('since');
});

test('"Say when the panels went up" on Accuracy opens the question, and answering it closes the matter', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page, HOME);
  await upload(page, 'HDF_kW_old.csv', esbFile('2026-05-26', 400));
  await page.getByRole('button', { name: /Yes, use this data/ }).click();
  // The new file, accepted without answering on the card.
  await upload(page, 'HDF_kW_new.csv', esbFile('2026-10-13', 400, PANELS));
  await page.getByRole('button', { name: /Yes, use this data/ }).click();
  await page.evaluate(() => { window.state._sheet = null; window.anTab('accuracy'); });
  // The sentence over the figure: written as a sentence, dates and units as they are.
  const line = await page.locator('.screen').innerText();
  const unknown = (line.match(/The biggest unknown is[^\n]*/) || [''])[0];
  expect(unknown, unknown).not.toMatch(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)\b|\bkwh\b|\.\./);
  await page.getByRole('button', { name: 'Say when the panels went up' }).first().click();   // on its row; the tab's foot has it too
  const sheet = page.locator('#v7-sheet');
  await expect(sheet).toContainText('Did your panels go in around 19 Jun 2026?');
  await sheet.getByRole('button', { name: /Yes, around then/ }).click();
  await expect(page.locator('#v7-sheet')).toHaveCount(0);
  expect(await page.evaluate(() => [window.state.file_when, window.fileBasis().ask])).toEqual(['sinceyes', null]);
  await expect(page.getByRole('button', { name: 'Say when the panels went up' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

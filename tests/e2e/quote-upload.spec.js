import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Upload a quote → see what was read and where → correct → model it.
 * The reading service is faked here: what is tested is that nothing is
 * modelled before the person confirms, and that what they confirm is what
 * the home is modelled with.
 */

const READ = {
  is_solar_quote: true, installer: 'Acme Solar', quote_date: '2026-09-20', panel_count: 14, panel_watts: 440,
  panel_model: 'Longi Hi-MO 6', system_kwp: 6.16, inverter_model: null, inverter_kw: null, battery_kwh: 10,
  battery_model: 'Sigenergy 10', price_total_eur: 13950, grant_eur: 1800, price_after_grant_eur: 12150,
  vat_included: true, orientation: 'south', roof_pitch_deg: 35, estimated_annual_kwh: null, extras: ['Bird mesh'],
  evidence: { panel_count: '14 x Longi 440W', panel_watts: '440W', battery_kwh: 'Sigenergy 10kWh',
    price_total_eur: 'Total inc VAT €13,950', grant_eur: 'SEAI grant -€1,800' },
  warnings: [],
};

const NO_SOLAR = { has_solar: false, considering_solar: false, count_A: 0, count_B: 0, battery_kwh: 0,
  install_cost: 0, grant_seai: 0, current_screen: 'solar' };

async function upload(page) {
  await page.locator('.v7-quote-tile').click();
  await page.locator('#v7-sheet input[type=file]').setInputFiles({
    name: 'quote.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test'),
  });
}

test('a read quote is shown for checking, with its evidence, before anything is modelled', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  let sent = null;
  await page.route('**/api/extract-quote', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quote: READ }) });
  });
  await upload(page);
  await expect(page.locator('#v7-sheet')).toContainText('Check what we read');
  expect(sent.media_type).toBe('application/pdf');
  await expect(page.locator('#v7-sheet')).toContainText('Total inc VAT €13,950');
  // Not modelled yet.
  expect(await page.evaluate(() => window.state.count_A)).toBe(0);

  // Correct one figure, then model.
  await page.locator('#qf-panels').fill('12');
  await page.getByRole('button', { name: /Use this quote/ }).click();
  const st = await page.evaluate(() => ({ n: window.state.count_A, w: window.state.panel_w, b: window.state.battery_kwh,
    c: window.state.install_cost, g: window.state.grant_seai, m: window.state.cost_is_manual, est: window.state.solar_is_estimate,
    az: window.state.azimuth_A, scr: window.state.current_screen }));
  expect(st).toEqual({ n: 12, w: 440, b: 10, c: 13950, g: 1800, m: true, est: false, az: 180, scr: 'solar' });
  await expect(page.locator('.qr-value')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a quote that cannot be read says why, and offers typing it in', async ({ page }) => {
  await boot(page, NO_SOLAR);
  await page.route('**/api/extract-quote', (route) => route.fulfill({ status: 422, contentType: 'application/json',
    body: JSON.stringify({ error: "That doesn't look like a solar or battery quote." }) }));
  await upload(page);
  await expect(page.locator('#v7-sheet')).toContainText("doesn't look like a solar");
  await expect(page.locator('#v7-sheet')).toContainText('Type the figures in instead');
  expect(await page.evaluate(() => window.state.count_A)).toBe(0);
});

test('a missing price must be filled in before modelling', async ({ page }) => {
  await boot(page, NO_SOLAR);
  await page.route('**/api/extract-quote', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ quote: { ...READ, price_total_eur: null, evidence: { ...READ.evidence, price_total_eur: null } } }) }));
  await upload(page);
  await expect(page.locator('#v7-sheet')).toContainText('Not on the quote');
  await page.getByRole('button', { name: /Use this quote/ }).click();
  expect(await page.evaluate(() => window.state.count_A)).toBe(0);
});

test('a quote over two roof faces is modelled as two faces, as the quote splits them', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  const split = { ...READ, panel_count: 22, orientation: 'south-west and south-east',
    roof_faces: [{ panels: 11, orientation: 'South West', tilt_deg: 30 }, { panels: 11, orientation: 'south east', tilt_deg: 30 }] };
  await page.route('**/api/extract-quote', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quote: split }) }));
  await upload(page);
  await expect(page.locator('.v7-qf-faces')).toContainText('Two roof faces');
  await expect(page.locator('#qf-fa')).toHaveValue('11');
  await expect(page.locator('.v7-qf-faces')).not.toContainText('evenly');
  await page.getByRole('button', { name: /Use this quote/ }).click();
  const st = await page.evaluate(() => ({ a: window.state.count_A, b: window.state.count_B, azA: window.state.azimuth_A, azB: window.state.azimuth_B, tA: window.state.tilt_A, tB: window.state.tilt_B }));
  expect(st).toEqual({ a: 11, b: 11, azA: 225, azB: 135, tA: 30, tB: 30 });
  expect(errors).toEqual([]);
});

test('two directions without counts are split evenly and the person is asked to check', async ({ page }) => {
  await boot(page, NO_SOLAR);
  await page.route('**/api/extract-quote', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ quote: { ...READ, panel_count: 15, orientation: 'East/West', roof_faces: null } }) }));
  await upload(page);
  await expect(page.locator('.v7-qf-faces')).toContainText('evenly');
  await page.locator('#qf-fa').fill('9'); await page.locator('#qf-fb').fill('6');
  await page.getByRole('button', { name: /Use this quote/ }).click();
  expect(await page.evaluate(() => [window.state.count_A, window.state.count_B, window.state.azimuth_A, window.state.azimuth_B])).toEqual([9, 6, 90, 270]);
});

test('directions in words read as azimuths', async ({ page }) => {
  await boot(page, NO_SOLAR);
  expect(await page.evaluate(() => ['south', 'South-West', 'SW', 's/e', 'southeast', 'East', 'north west', '200°', 'roof'].map(window.azFromWords)))
    .toEqual([180, 225, 225, 135, 135, 90, 315, 200, null]);
});

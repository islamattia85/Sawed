import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The Solar tab used to arrive fully formed.
 *
 * Opening it called exploreSolar(), which invented a system from the reader's
 * bill, and maybeAutoPaybackView(), which entered the "fastest payback" design
 * view — so someone who had never said they were interested in solar was handed
 * four screens of finished analysis about a twelve-thousand-euro purchase,
 * fronted by a chooser asking them to pick between two objective functions
 * before they could see a single number.
 *
 * It now opens on one question and grows with the answers.
 */

const NO_SOLAR = {
  has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0,
  current_screen: 'result',
};

const size = (page) => page.evaluate(() => ({
  stage: window.solarStage(),
  screens: +(document.body.scrollHeight / window.innerHeight).toFixed(1),
  words: document.body.innerText.trim().split(/\s+/).length,
  sections: document.querySelectorAll('.section-title').length,
}));

test('the tab opens on a question, not a dashboard', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));

  const m = await size(page);
  expect(m.stage, 'a system was fabricated on tab entry').toBe(0);
  expect(m.screens, 'the first thing shown is longer than a screen').toBeLessThanOrEqual(1.2);
  expect(m.sections, 'analysis sections rendered before any decision').toBe(0);

  await expect(page.getByRole('heading', { name: /Do you have solar panels/i })).toBeVisible();
  // Two answers, and nothing else to weigh up.
  await expect(page.locator('.solar-start-btn')).toHaveCount(2);

  // Crucially, no system has been invented behind the question.
  expect(await page.evaluate(() => window.state.count_A)).toBe(0);
  expect(errors).toEqual([]);
});

test('answering reveals one recommendation, and the working stays behind a door', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));

  await page.getByRole('button', { name: /show me what one would do/i }).click();
  const one = await size(page);
  expect(one.stage).toBe(1);
  expect(one.screens, 'stage one is as long as the old full dashboard').toBeLessThan(2.5);

  // A system now exists, and it is the recommended one.
  const applied = await page.evaluate(() => ({
    panels: window.state.count_A, batt: window.state.battery_kwh,
    best: window.bestDesign(),
  }));
  expect(applied.panels).toBe(applied.best.panels);
  expect(applied.batt).toBe(applied.best.batt);

  // The headline answer is present…
  await expect(page.locator('.qr-value')).toContainText(/yr payback/);
  // …and the detail is not, until asked for.
  await expect(page.locator('.solar-more')).toBeVisible();
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Day inspector/i);

  await page.locator('.solar-more').click();
  const two = await size(page);
  expect(two.stage).toBe(2);
  expect(two.sections, 'opening the detail revealed nothing new').toBeGreaterThan(2);
  expect(two.screens).toBeGreaterThan(one.screens);

  expect(errors).toEqual([]);
});

test('there is one recommendation, not a choice of objective functions', async ({ page }) => {
  const errors = await boot(page, { has_solar: true, considering_solar: true, count_A: 8, battery_kwh: 5, current_screen: 'solar' });

  const text = await page.evaluate(() => document.body.innerText);
  expect(text, 'the goal chooser is still on screen').not.toMatch(/Fastest payback|Most 20-yr value|Design my system/i);

  // A single, defensible pick: best twenty-year value, cheapest of the near-ties.
  const d = await page.evaluate(() => window.bestDesign());
  expect(d).not.toBeNull();
  expect(d.payback).toBeGreaterThan(0);
  expect(d.npv).toBeGreaterThan(0);

  const sweep = await page.evaluate(() => window.sweepGoalDesigns?.() ?? null);
  if (sweep) {
    const top = Math.max(...sweep.designs.map((x) => x.npv));
    expect(d.npv, 'the pick is not within 5% of the best 20-year value').toBeGreaterThanOrEqual(top * 0.95);
    const nearTies = sweep.designs.filter((x) => x.npv >= top * 0.95);
    const cheapest = Math.min(...nearTies.map((x) => x.net));
    expect(d.net, 'a cheaper design matched it on value').toBe(cheapest);
  }
  expect(errors).toEqual([]);
});

test('“I already have panels” goes to the spec, not to a guess', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));

  await page.getByRole('button', { name: /already have panels/i }).click();
  // Straight to describing the real system rather than modelling an imagined one.
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('refine');
  expect(await page.evaluate(() => window.state.solar_is_estimate)).toBe(false);
  expect(errors).toEqual([]);
});

test('the weather range is part of the working, not the headline', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));
  await page.getByRole('button', { name: /show me what one would do/i }).click();

  // Three more buttons to weigh at the moment of decision is the problem, not
  // the solution. The range is honest and stays — one level down.
  let text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bWorst\b/);

  await page.locator('.solar-more').click();
  text = await page.evaluate(() => document.body.innerText);
  expect(text).toMatch(/\bWorst\b/);
  expect(errors).toEqual([]);
});

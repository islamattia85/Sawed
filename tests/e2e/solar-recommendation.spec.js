import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The Solar tab answers first.
 *
 * It used to open on "Design my system" — three tabs, My system against
 * Fastest payback against Most 20-yr value, each with a ranked list to page
 * through. A homeowner is not choosing between objective functions; asking them
 * to pick a metric before they can see a number is asking them to do our job.
 *
 * A first attempt at fixing that replaced the chooser with a full-screen
 * question and a generic "Show me the detail" button. That was worse: a gate
 * costs a tap and returns nothing, and "detail" says nothing about what is
 * behind it. Two walls instead of three tabs is not a simplification.
 *
 * So: no question, no gate, no modes. The screen lands on a working answer,
 * offers a better system underneath it, and gives one quiet sentence for
 * anyone we guessed wrong about.
 */

const NO_SOLAR = {
  has_solar: false, considering_solar: false, count_A: 0, battery_kwh: 0,
  current_screen: 'result',
};

test('the tab lands on an answer, with nothing to choose or unlock first', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));

  // A number, immediately.
  await expect(page.locator('.qr-value')).toContainText(/yr payback/);

  const text = await page.evaluate(() => document.body.innerText);
  expect(text, 'the goal chooser is still here').not.toMatch(/Fastest payback|Most 20-yr value|Design my system/i);
  expect(text, 'a gate is standing in front of the answer').not.toMatch(/Do you have solar panels|Show me the detail/i);

  // And the whole screen is present — nothing hidden behind a mode.
  const sections = await page.locator('.section-title').count();
  expect(sections, 'sections were hidden behind a disclosure').toBeGreaterThan(2);

  expect(errors).toEqual([]);
});

test('the answer is not blocked by the twelve-design sweep', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);

  const started = Date.now();
  await page.evaluate(() => window.setScreen('solar'));
  await expect(page.locator('.qr-value')).toContainText(/yr payback/);
  const elapsed = Date.now() - started;

  // Simulating twelve designs across a full year takes seconds. It must not
  // hold the first paint; it arrives afterwards and offers itself.
  expect(elapsed, `first paint waited ${elapsed}ms for the design sweep`).toBeLessThan(2000);
  expect(errors).toEqual([]);
});

test('a better system is offered after the answer, never before it', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));

  // The recommendation arrives once the sweep lands.
  const card = page.locator('.opt-card, .opt-note').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => page.evaluate(() => !document.querySelector('.opt-note.is-working')),
    { timeout: 20_000 },
  ).toBe(true);

  // It follows the reader's own figure rather than correcting them first.
  const order = await page.evaluate(() => {
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    };
    return { hero: y('.sd-hero'), rec: y('.opt-card, .opt-note') };
  });
  expect(order.rec, 'the recommendation is above the reader’s own number')
    .toBeGreaterThan(order.hero);

  expect(errors).toEqual([]);
});

test('the recommendation is a single defensible pick, and applying it works', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));
  await expect.poll(
    () => page.evaluate(() => !document.querySelector('.opt-note.is-working')),
    { timeout: 20_000 },
  ).toBe(true);

  const { d, sweep } = await page.evaluate(() => ({
    d: window.bestDesign(), sweep: window.sweepGoalDesigns(),
  }));
  // Best twenty-year value; cheapest of anything within 5% of it.
  const top = Math.max(...sweep.designs.map((x) => x.npv));
  expect(d.npv).toBeGreaterThanOrEqual(top * 0.95);
  const nearTies = sweep.designs.filter((x) => x.npv >= top * 0.95);
  expect(d.net).toBe(Math.min(...nearTies.map((x) => x.net)));

  const btn = page.getByRole('button', { name: /Use this system/i });
  if (await btn.count()) {
    await btn.click();
    await expect.poll(() => page.evaluate(() => window.state.count_A)).toBe(d.panels);
    expect(await page.evaluate(() => window.state.battery_kwh)).toBe(d.batt);
    // Now that we are on it, the offer becomes a one-line confirmation.
    await expect(page.locator('.opt-note')).toBeVisible();
    await expect(page.getByRole('button', { name: /Use this system/i })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('correcting our guess is a sentence, not a gate', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));

  const correct = page.locator('.solar-correct');
  await expect(correct).toBeVisible();
  await expect(correct).toContainText(/Already have panels/i);

  await correct.getByRole('link', { name: /exact spec/i }).click();
  await expect.poll(() => page.evaluate(() => window.state.current_screen)).toBe('refine');
  expect(errors).toEqual([]);
});

test('the weather range qualifies the figure instead of standing in front of it', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'solar', has_solar: true, considering_solar: true, count_A: 12, battery_kwh: 5 });

  const order = await page.evaluate(() => {
    const y = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    };
    return { figure: y('.qr-value'), range: y('.wx-range') };
  });
  expect(order.range, 'the range control precedes the number it qualifies')
    .toBeGreaterThan(order.figure);

  // Still works.
  await page.locator('.wx-range-btn', { hasText: 'Poor' }).click();
  expect(await page.evaluate(() => window.state._scenario_view)).toBe('pessimist');
  expect(errors).toEqual([]);
});

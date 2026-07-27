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
 * So: no question, no gate, no modes. The screen lands on a working answer and
 * gives one quiet sentence for anyone we guessed wrong about.
 *
 * It also no longer offers a different system. A suggested spec sitting beside
 * the reader's own turned "is this worth it" into a comparison they had not
 * asked for, and made it hard to tell which figures described which system.
 * That belongs where someone has already decided to change the spec, so it
 * lives on the customise screen.
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

test('the solar tab does not offer a second system alongside the reader’s own', async ({ page }) => {
  const errors = await boot(page, NO_SOLAR);
  await page.evaluate(() => window.setScreen('solar'));
  await page.waitForTimeout(2500);      // long enough for the old sweep to land

  // The tab answers one question: is this worth it. A suggested system sitting
  // beside the reader's own turned that into a comparison they had not asked
  // for, and made it genuinely hard to tell which figures belonged to which.
  // The suggestion lives on the customise screen now.
  await expect(page.locator('.opt-card')).toHaveCount(0);
  await expect(page.locator('.opt-note')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.innerText))
    .not.toMatch(/better size for your roof/i);

  expect(errors).toEqual([]);
});

test('the suggestion is on the customise screen, above the controls it changes', async ({ page }) => {
  // A home that is actually modelling a system: with nothing configured the
  // section offers "add a solar system" instead, which is the right answer to
  // a different question.
  const errors = await boot(page, { has_solar: true, considering_solar: true, count_A: 12, battery_kwh: 5 });
  await page.evaluate(() => {
    window.setScreen('refine');
    window.state._settings_open = 'solar';
    window.renderApp();
  });

  const card = page.locator('.opt-card, .opt-note').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => page.evaluate(() => !document.querySelector('.opt-note.is-working')),
    { timeout: 20_000 },
  ).toBe(true);

  const placed = await page.evaluate(() => {
    const el = document.querySelector('.opt-card, .opt-note');
    const section = [...document.querySelectorAll('.settings-section-card')]
      .find((c) => /Solar system/.test(c.textContent));
    const firstControl = document.querySelector('.refine-row');
    return {
      inSolarSection: !!(section && section.contains(el)),
      aboveControls: firstControl
        ? el.getBoundingClientRect().top < firstControl.getBoundingClientRect().top : null,
    };
  });
  expect(placed.inSolarSection, 'the suggestion is not in the solar section').toBe(true);
  expect(placed.aboveControls, 'the suggestion is below the controls it would change').toBe(true);

  expect(errors).toEqual([]);
});

test('a collapsed section does not start the twelve-design sweep', async ({ page }) => {
  await boot(page, NO_SOLAR);
  await page.evaluate(() => {
    window.setScreen('refine');
    window.state._settings_open = 'home';
    window.renderApp();
  });
  await page.waitForTimeout(800);
  // Section bodies render even when closed. Simulating twelve designs for a
  // section nobody has opened is work done for nothing.
  await expect(page.locator('.opt-card, .opt-note')).toHaveCount(0);
});

test('the recommendation is a single defensible pick, and applying it works', async ({ page }) => {
  const errors = await boot(page, { has_solar: true, considering_solar: true, count_A: 12, battery_kwh: 5 });
  await page.evaluate(() => {
    window.setScreen('refine');
    window.state._settings_open = 'solar';
    window.renderApp();
  });
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

  const btn = page.getByRole('button', { name: /Switch to the suggested system/i });
  if (await btn.count()) {
    await btn.click();
    await expect.poll(() => page.evaluate(() => window.state.count_A)).toBe(d.panels);
    expect(await page.evaluate(() => window.state.battery_kwh)).toBe(d.batt);
    // Now that we are on it, the offer becomes a one-line confirmation.
    await expect(page.locator('.opt-note')).toBeVisible();
    await expect(page.getByRole('button', { name: /Switch to the suggested system/i })).toHaveCount(0);
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

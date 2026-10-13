import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * Direction section 2 (13 Oct 2026): the household score, its levels and
 * challenges, the points and the savings tally are gone, code and saved
 * fields alike. What the app tells people is news and plain things to do.
 */

const RETIRED = ['score_seen', 'quests_done', 'journey', '_quest_sel', '_score_open'];

test('a home saved with the score and the tally loads without them, and none of it goes to the account', async ({ page }) => {
  const errors = await boot(page, {
    score_seen: 62, quests_done: { habits: '2026-09-01T10:00:00Z' }, _quest_sel: 1, _score_open: true,
    journey: [{ type: 'switch', at: '2026-09-01', from: 'EI-24', to: 'EN-SMART', label: 'Switched to Energia Smart Data', per_year: 120 }],
  });
  const left = await page.evaluate((keys) => keys.filter((k) => k in window.state), RETIRED);
  expect(left).toEqual([]);
  await page.evaluate(() => window.saveState());
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('solarAppState_v2')));
  expect(RETIRED.filter((k) => k in saved)).toEqual([]);
  // An account copy saved before carries them; taking it, or sending one, drops them.
  const copy = await page.evaluate((keys) => {
    const remote = { ...window.state, score_seen: 50, journey: [{ type: 'install', at: '2026-08-01', per_year: 300 }], quests_done: {} };
    return Object.keys(window.__sync.cloudCopy(remote)).filter((k) => keys.includes(k));
  }, RETIRED);
  expect(copy).toEqual([]);
  expect(errors).toEqual([]);
});

test('Updates is news and plain to-dos: no score, points, level or tally', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'updates', contract_end: null, _csv_imported: false });
  const text = await page.locator('.screen').innerText();
  expect(text).not.toMatch(/score|points|\blevel\b|saved so far|tally|of 100|challenge|do it now/i);
  await expect(page.locator('.up-progress, .up-pts, .gm, .me-tally')).toHaveCount(0);
  // Each to-do is a title, one line and a chevron.
  const rows = page.locator('.up-todo .up-row');
  await expect(rows.first()).toBeVisible();
  const titles = await rows.locator('b').allInnerTexts();
  expect(titles).toEqual(expect.arrayContaining(['Upload your ESB meter file', 'Add your contract end date']));
  for (const shape of await rows.evaluateAll((els) => els.map((el) => ({
    b: el.querySelectorAll('b').length, small: el.querySelectorAll('small').length, i: el.querySelectorAll('i').length, svg: el.querySelectorAll('svg').length })))) {
    expect(shape).toEqual({ b: 1, small: 1, i: 0, svg: 1 });
  }
  // Price watch and the email switch stay.
  await expect(page.getByRole('button', { name: /Price watch/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the Bill tab has no plan health, and a switch is recorded plainly', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'analytics', _an_tab: 'bill' });
  await expect(page.locator('h1.ax-h')).toHaveText('Where does your money go?');
  await expect(page.locator('.screen')).not.toContainText(/Plan health|of 100/);
  const to = await page.evaluate(() => window.getRecommendation().ranked.map((r) => r.plan).find((p) => p.id !== window.state.baseline));
  await page.evaluate((id) => window.recordSwitch(id), to.id);
  await expect(page.locator('#toast-stack')).toContainText(`Your plan is now ${to.supplier} ${to.plan}`);
  await expect(page.locator('#toast-stack')).not.toContainText(/tally|points|a year from/i);
  expect(await page.evaluate(() => [window.state.baseline, 'journey' in window.state])).toEqual([to.id, false]);
  expect(errors).toEqual([]);
});

test('an old link to a score, challenge or tally sheet opens nothing', async ({ page }) => {
  const errors = await boot(page, { current_screen: 'updates' });
  for (const [kind, id] of [['score'], ['quest', '0'], ['habits'], ['journey', 'switch'], ['journey', 'install']]) {
    await page.evaluate(([k, i]) => window.v7Sheet(k, i), [kind, id]);
    await expect(page.locator('#v7-sheet'), kind).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

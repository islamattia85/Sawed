/**
 * Every figure assumes the battery tops up on night power wherever that pays:
 * the app tells people to set it that way. The plan the home is on is no
 * exception. How the battery runs today only changes how a typed bill is read.
 *
 * From 6 to 10 October 2026 the current plan was priced as if the battery only
 * stored solar whenever the owner said no, wasn't sure, or wasn't asked, and
 * homes with a meter file are never asked. A heat pump home on EV Smart Drive
 * with a 9 kWh battery was told its plan cost EUR 1,094 a year, not EUR 692.
 */
import { test, expect } from '@playwright/test';
import { runScenario, TRUTH } from './run-scenario.js';
import { isolate } from './support.js';

const fresh = async (page) => { await isolate(page); await page.goto('/app?fresh'); await page.waitForFunction(() => window.__bootSettled === true); };

/** The plan the home is on: what it costs, what it costs in the ranking, and the battery's 02:00-06:00 charging. */
const current = (page) => page.evaluate(() => {
  const id = window.state.baseline, p = window.getPlanById(id), s = window.sim(id);
  let windowCharge = 0;
  for (let i = 0; i < s.battery_charge.length; i++) { const h = i % 24; if (h >= 2 && h < 6) windowCharge += s.battery_charge[i]; }
  const ranked = window.getRecommendation().ranked.find((r) => r.plan.id === id);
  const asIfYes = window.withSimState({ grid_charge_now: 'yes' }, () => window.annualCost(window.sim(id), p).net);
  return { id, net: window.annualCost(s, p).net, ranked: ranked ? ranked.net : null, asIfYes, windowCharge };
});

test('a meter file from before the panels: the current plan is priced with the battery filling at night', async ({ page }) => {
  test.setTimeout(120_000);
  const sc = { id: 'battery-night', file: 'B1a_friend.csv', truth: 'friend',
    answers: { heat: 'heatpump', solar: 'have', battery: 9, filewhen: 'before', plan: 'EN-EV' }, system: TRUTH.friend.system };
  await runScenario(page, sc);
  const c = await current(page);
  expect(c.id).toBe('EN-EV');
  expect(c.windowCharge, 'the battery fills in the 02:00-06:00 window').toBeGreaterThan(500);
  expect(Math.abs(c.net - c.ranked), 'the current plan costs what the ranking says it costs').toBeLessThan(1);
  expect(Math.abs(c.net - c.asIfYes), 'and what it would if the owner had said yes').toBeLessThan(1);
});

test('a typed bill: the plan is priced the same whatever the battery answer; only a no changes how the bill is read', async ({ page }) => {
  test.setTimeout(120_000);
  const run = async (ans) => { await fresh(page); return page.evaluate((ans) => {
    startFlow('full'); flowAnswer('bill', 160); flowAnswer('meter', 'smart'); flowAnswer('area', 'urban'); flowAnswer('plan', 'EN-EV'); flowAnswer('disc', 0);
    flowAnswer('heat', 'heatpump'); flowAnswer('night', 'no'); flowAnswer('solar', 'have'); flowAnswer('where', 'south'); flowAnswer('roof', 'S'); flowAnswer('tilt', 35); flowAnswer('panels', 10); flowAnswer('battery', 9);
    flowAnswer('gridnow', ans); flowAnswer('price', 0); flowAnswer('grant', 'no'); flowAnswer('ev', 'no'); flowFinish();
    return { kwh: Object.values(state.bills).reduce((a, b) => a + b, 0), note: !!document.querySelector('.gc-now') };
  }, ans); };
  const out = {};
  for (const ans of ['yes', 'unsure', 'no']) {
    out[ans] = { ...(await run(ans)), ...(await current(page)) };
    expect(Math.abs(out[ans].net - out[ans].asIfYes), `${ans}: priced with night top-ups`).toBeLessThan(1);
    expect(Math.abs(out[ans].net - out[ans].ranked), `${ans}: the same price as in the ranking`).toBeLessThan(1);
    expect(out[ans].windowCharge, `${ans}: the battery fills at night`).toBeGreaterThan(500);
  }
  expect(out.unsure.kwh, 'not sure reads the bill as yes does').toBe(out.yes.kwh);
  expect(out.no.kwh, 'a battery that only stores solar ran up the bill on less use').toBeLessThan(out.yes.kwh);
  expect([out.yes.note, out.unsure.note, out.no.note]).toEqual([false, false, true]);
});

// Shared by meter-scenarios.spec.js (the full set, for the report) and
// golden-households.spec.js (the reference set CI runs on every push).
//
// One scenario, as a person would do it: start setup, upload the ESB file,
// answer the questions the app asks the way this person would, then read what
// the app concluded. Prices and today's date are frozen so the answers can be
// compared with stored true values.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isolate } from './support.js';

export const DIR = new URL('../fixtures/meter-scenarios/', import.meta.url).pathname;
export const SCENARIOS = JSON.parse(readFileSync(DIR + 'scenarios.json', 'utf8'));
export const TRUTH = JSON.parse(readFileSync(DIR + 'truth.json', 'utf8'));
const TARIFFS = readFileSync(DIR + 'tariffs-2026-10-09.json');
export const TODAY = new Date('2026-10-09T12:00:00Z');

const fileOf = (name) => ({ name: name.replace(/\.gz$/, '').replace(/^.*\//, ''), mimeType: 'text/csv', buffer: gunzipSync(readFileSync(DIR + 'files/' + name.replace(/(\.gz)?$/, '.gz'))) });

/** What each question gets when the scenario does not say: an ordinary urban home in Cork on Electric Ireland. */
const DEFAULTS = { meter: 'smart', area: 'urban', plan: 'EI-24', disc: 0, heat: 'gas', heattime: 'day', night: 'no', gas: 'no', solar: 'no',
  where: 'south', house: 'semi', roof: 'S', tilt: 35, system: 'custom', panels: 9, battery: 0, gridnow: 'no', price: 0, grant: 'no',
  ev: 'no', km: 15000, car: 17, evtime: 'night', billwhen: 'after', billmonths: 'average', filewhen: 'allyear' };

const questionOn = (page) => page.evaluate(() => {
  const o = document.querySelector('.fl-q [data-q]'); if (o) return o.dataset.q;
  const own = document.querySelector('.fl-q [id^=flow-own-]'); if (own) return own.id.slice(9);
  if (document.querySelector('.fl-sups, .fl-sup')) return 'plan';
  if (document.querySelector('#flow-bill')) return 'bill';
  return null;
});

/**
 * Run one scenario. `shots` (optional): a directory to save what the person saw.
 * Returns what the app did and concluded.
 */
export async function runScenario(page, sc, shots) {
  await isolate(page);
  await page.clock.setFixedTime(TODAY);
  await page.route('**/tariffs.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: TARIFFS }));
  await page.goto('/?fresh');
  await page.waitForFunction(() => window.__bootSettled === true);
  const a = { ...DEFAULTS, ...sc.answers };
  const seen = { import: [], questions: [], rejected: null };
  const shot = async (loc, name) => { if (shots) await loc.screenshot({ path: `${shots}/${sc.id}-${name}.png` }).catch(() => {}); };

  await page.evaluate(() => window.startFlow('full'));
  if (a.typed) {
    // Typed a yearly figure first: the meter file comes later, from the Updates to-do.
    await answerAll(page, { ...a, bill: 'kwh:' + a.typed, filewhen: undefined }, seen, shot, ['bill']);
  }
  const files = sc.files || [sc.file];
  for (const [n, name] of files.entries()) {
    if (a.typed) { await page.evaluate(() => { window.flowFinish && window.state.current_screen === 'flow' && window.flowFinish(); window.v7Sheet('meter'); }); }
    const input = page.locator(a.typed ? 'input[type=file]' : '.fl-upload input[type=file]').first();
    await input.setInputFiles(fileOf(name)).catch((e) => { seen.rejected = 'upload failed: ' + e.message; });
    const res = page.locator('#csv-parse-result');
    await page.waitForFunction(() => { const t = document.querySelector('#csv-parse-result')?.innerText || ''; return t && !/Parsing/.test(t); }, null, { timeout: 60_000 }).catch(() => {});
    seen.import.push((await res.innerText().catch(() => '')).trim());
    await shot(res, `import${n + 1}`);
  }
  const use = page.getByRole('button', { name: /Use this data/ });
  if (!(await use.count())) {
    seen.rejected = seen.rejected || seen.import[seen.import.length - 1] || 'no result shown';
    return { id: sc.id, seen };
  }
  await use.first().click();
  await page.waitForTimeout(400);
  if (!a.typed) await answerAll(page, a, seen, shot);
  await page.evaluate(() => { if (window.state.current_screen === 'flow') window.flowFinish(); });
  // The system the person states, set as they would in My system.
  const sys = sc.system || (a.solar === 'have' || a.solar === 'thinking' ? (TRUTH[sc.truth].system) : null);
  await page.evaluate(([sys, solar, ov]) => {
    const s = window.state;
    if (sys && solar !== 'no') {
      const [fa, fb] = sys.faces;
      Object.assign(s, { has_solar: true, count_A: fa[0], azimuth_A: fa[1], tilt_A: fa[2], count_B: fb ? fb[0] : 0, azimuth_B: fb ? fb[1] : s.azimuth_B, tilt_B: fb ? fb[2] : s.tilt_B,
        panel_w: sys.panel_w, battery_kwh: sys.battery, install_cost: sys.cost, grant_seai: sys.grant, cost_is_manual: true, grant_is_manual: true, grant_eligible: sys.grant > 0 });
    }
    if (ov) Object.assign(s, ov);
    window.invalidate();
  }, [sys, a.solar, sc.override || null]);
  await page.evaluate(() => window.setScreen('result'));
  await page.waitForTimeout(300);
  await shot(page.locator('.screen').first(), 'home');
  const out = await page.evaluate(() => {
    const s = window.state, sum = (o) => Object.values(o || {}).reduce((x, y) => x + y, 0);
    const rec = window.getRecommendation();
    let solar = null;
    try { const d = window.v7SolarData(); if (d && d.cur && d.cur.payback !== 999) solar = { payback: d.cur.payback, saving: d.cur.solarBenefit, costNoSolar: d.cur.costNoSolar, costWithSolar: d.cur.costWithSolar, sysCost: d.sysCost }; } catch (e) {}
    const acc = window.modelAccuracy ? window.modelAccuracy() : { pct: null, parts: [] };
    const fb = window.fileBasis ? window.fileBasis() : null;
    // A home planning solar: the plans as it is today, without the planned panels.
    let today = null;
    if (s.solar_planned) { try { today = window.withSimState({ has_solar: false }, () => window.getRecommendation().ranked.map((r) => ({ id: r.plan.id, net: Math.round(r.net) }))); } catch (e) {} }
    // A battery: the ranking the Plans page also gives, for a battery that only stores solar.
    let solarOnly = null;
    if (s.has_solar && s.battery_kwh > 0) { try { solarOnly = window.withSimState({ strategy_mode: 'self-consume', charge_from_grid: false }, () => window.getRecommendation().ranked.map((r) => ({ id: r.plan.id, net: Math.round(r.net) }))); } catch (e) {} }
    return { kwh: Math.round(sum(s.bills)), bills: s.bills, best: rec.best.plan.id, bestNet: Math.round(rec.best.net), today, solarOnly,
      ranked: rec.ranked.map((r) => ({ id: r.plan.id, net: Math.round(r.net) })), solar, basis: fb, accuracy: { pct: acc.pct, parts: acc.parts.map((p) => `${p.label} ±${p.err}%`) },
      csvDays: s._csv_days, periods: s._csv_periods, fileWhen: s.file_when || null, hasSolar: !!s.has_solar, planned: !!s.solar_planned,
      hero: (document.querySelector('.v7-hero') || document.querySelector('.screen'))?.innerText.slice(0, 600) || '' };
  });
  return { id: sc.id, seen, ...out };
}

async function answerAll(page, a, seen, shot, stopAfter = []) {
  for (let i = 0; i < 40; i++) {
    const q = await questionOn(page);
    if (!q) break;
    // Only what is on the screen can be chosen. A scenario may list answers in order of
    // preference (the truthful one first); the first one offered is taken.
    const offered = await page.evaluate((q) => [...document.querySelectorAll('.fl-q [onclick*="flowAnswer"]')]
      .map((e) => (e.getAttribute('onclick') || '').match(/flowAnswer\('([^']+)',\s*'?([^')]*?)'?\)/)).filter((m) => m && m[1] === q).map((m) => m[2]), q);
    const want = a[q] !== undefined ? a[q] : DEFAULTS[q];
    const prefs = Array.isArray(want) ? want : [want];
    const pick = offered.length ? prefs.find((x) => offered.includes(String(x))) : prefs[0];
    const v = pick !== undefined ? pick : prefs[0];
    const fits = !offered.length || offered.includes(String(v)) || !Array.isArray(want) && typeof want === 'number';
    const text = await page.evaluate(() => { const h = document.querySelector('.fl-q h2'), p = document.querySelector('.fl-q h2 + p, .fl-q .fl-sub'); return [h?.innerText || '', p?.innerText || ''].join(' — '); });
    seen.questions.push({ q, text, answer: v, offered, fits });
    if (['filewhen', 'solar'].includes(q) || /panels|file|meter/i.test(text)) await shot(page.locator('.fl-q').first(), `q-${q}`);
    if (v === undefined) { seen.questions.push({ q, text: 'unanswered' }); break; }
    await page.evaluate(([q, v]) => window.flowAnswer(q, v), [q, v]);
    await page.waitForTimeout(100);
    if (stopAfter.includes(q) && i > 0) { /* keep going to the end of setup */ }
  }
}

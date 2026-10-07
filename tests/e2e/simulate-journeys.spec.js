/**
 * Simulated people: each starts from a fresh install, answers setup at random
 * (as a person would, with the app's own handlers), then does a random series
 * of real actions. After every step: no error, no NaN/undefined on screen, and
 * the best plan never costs more than the plan the home is on.
 */
import { test, expect } from '@playwright/test';
import { isolate, collectErrors } from './support.js';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const SEEDS = Array.from({ length: Number(process.env.JOURNEY_N || 25) }, (_, i) => 500 + i * 104729);
const PLANS = ['EI-24', 'EI-SST', 'BG-24', 'BG-EV', 'EN-SMART-24-HOUR', 'EN-SMART', 'SSE-24', 'SSE-DNP', 'YN-24', 'FL-24', 'PIN-LF', 'unsure'];

for (const seed of SEEDS) {
  test(`simulated person ${seed}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.setFixedTime(new Date('2026-10-04T12:00:00Z'));
    const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
    await isolate(page);
    const errors = collectErrors(page);
    const reported = [];
    page.on('request', (q) => { if (q.url().includes('/api/error')) reported.push(q.postData()); });
    await page.goto('/app');
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sawed_analytics', 'no'); });
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('loader'));
    await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });

    // Setup, answered at random.
    const a = {
      bill: pick([80, 150, 250, 420, 700]), plan: pick(PLANS), heat: pick(['gas', 'heatpump', 'storage', 'direct']),
      gas: pick(['yes', 'no']), gasbill: pick([0, 150, 300]), solar: pick(['no', 'no', 'have', 'thinking']),
      roof: pick(['S', 'SE', 'SW', 'EW', 'SESW', 'unsure']), panels: pick([6, 10, 14, 20]), battery: pick([0, 5, 10]),
      ev: pick(['no', 'no', 'have', 'thinking']), km: pick([8000, 16000, 25000]), car: pick([14, 17, 20]),
    };
    const log = [`answers ${JSON.stringify(a)}`];
    await page.evaluate((a) => {
      startFlow();
      const ans = (q, v) => flowAnswer(q, v);
      ans('bill', a.bill); ans('plan', a.plan); ans('heat', a.heat);
      if (document.querySelector('.fl-opts') && /gas with/i.test(document.body.innerText)) { ans('gas', a.gas); if (a.gas === 'yes') ans('gasbill', a.gasbill); }
      ans('solar', a.solar);
      if (a.solar !== 'no') { ans('roof', a.roof); ans('panels', a.panels); ans('battery', a.battery); }
      ans('ev', a.ev);
      if (a.ev !== 'no') { ans('km', a.km); ans('car', a.car); }
      flowFinish();
    }, a);

    const check = async (step) => {
      await page.waitForTimeout(300);
      const txt = await page.locator('#app-root').innerText();
      const ctx = `${log.join(' → ')} → ${step}`;
      expect(txt.match(/NaN|undefined|Infinity|\[object Object\]/), ctx).toBeNull();
      const f = await page.evaluate(() => { const rec = getRecommendation(); return { base: rec.baseCost, best: rec.best && rec.best.net, solar: state.has_solar, ev: state.ev_active }; });
      expect(Number.isFinite(f.best) && Number.isFinite(f.base), ctx).toBe(true);
      if (!f.solar && !f.ev) expect(f.best, ctx).toBeLessThanOrEqual(f.base + 0.5);
      expect(errors, ctx).toEqual([]);
      expect(reported, ctx).toEqual([]);
      log.push(step);
    };
    const done = await page.evaluate(() => ({ ok: state.onboarding_complete, screen: state.current_screen, solar: state.has_solar, ev: state.ev_active }));
    expect(done.ok && done.screen === 'result', log[0]).toBe(true);
    expect(done.solar, log[0]).toBe(a.solar !== 'no');
    expect(done.ev, log[0]).toBe(a.ev !== 'no');
    if (a.solar === 'no' && a.ev !== 'have') {
      const b = await page.evaluate(() => { const p = getPlanById(state.baseline); return { year: window.__sim.baselineNet(), bill: state.bimonthly_bill_eur,
        rise: !!(p.price_change && Date.parse(p.price_change.effective_date) > Date.now()) }; });
      if (!b.rise) expect(Math.abs(b.year - b.bill * 6) / (b.bill * 6), `year €${b.year.toFixed(0)} vs bill ×6 ${log[0]}`).toBeLessThan(0.03);
    }
    await check('setup done');

    const ACTIONS = {
      'open best plan': "v7Sheet('plan', getRecommendation().best.plan.id)",
      'open switch sheet': "v7Sheet('switch', getRecommendation().best.plan.id)",
      'record the switch': "v7Sheet(null); recordSwitch(getRecommendation().best.plan.id)",
      'plans tab': "v7Sheet(null); setScreen('plans')",
      'analytics bill': "v7Sheet(null); setScreen('analytics'); anTab('bill')",
      'analytics hours': "v7Sheet(null); setScreen('analytics'); anTab('hours')",
      'analytics solar': "v7Sheet(null); setScreen('analytics'); anTab('solar')",
      'analytics car': "v7Sheet(null); setScreen('analytics'); anTab('car')",
      'my home': "v7Sheet(null); openMyHome()",
      'my system': "v7Sheet(null); openMySystem()",
      'quick change, use it': "v7Sheet(null); if (state.has_solar) { openQuickSystem(); qsStep('a', 1); qsStep('batt', 1); qsApply(); }",
      'undo': 'undoLast()',
      'solar guide': "v7Sheet(null); startSolarGuide()",
      'ev guide': "v7Sheet(null); startEvGuide()",
      'home': "v7Sheet(null); setScreen('result')",
      'me': "v7Sheet(null); setScreen('me')",
      'leave the EV out / back in': "v7Sheet(null); setScreen('result'); if (state.ev_active || state._ev_left_out) toggleEvModel()",
      'leave solar out / back in': "v7Sheet(null); setScreen('result'); if (state.has_solar || state.solar_planned) toggleSolarModel()",
      'change the bill': "homeSet('bimonthly_bill_eur', String(80 + Math.round(Math.random()*600)))",
      'grant: not eligible': "setGrantEligible(false)",
      'back gesture': 'history.back()',
    };
    const names = Object.keys(ACTIONS);
    for (let i = 0; i < 14; i++) {
      const n = pick(names);
      await page.evaluate((s) => { try { (0, eval)(s); } catch (e) { window.__actErr = String(e); } }, ACTIONS[n]);
      const ae = await page.evaluate(() => window.__actErr);
      expect(ae, `${log.join(' → ')} → ${n}`).toBeUndefined();
      await check(n);
    }
  });
}

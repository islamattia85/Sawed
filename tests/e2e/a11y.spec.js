import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { boot } from './support.js';
const SOLAR = { has_solar: true, considering_solar: true, solar_planned: true, count_A: 10, battery_kwh: 9 };
const VIEWS = [
  ['Home', "setScreen('result')"], ['Plans', "setScreen('plans')"], ['Analytics Bill', "setScreen('analytics'); anTab('bill')"],
  ['Analytics Hours', "anTab('hours')"], ['Analytics Solar', "anTab('solar')"], ['Analytics Accuracy', "anTab('accuracy')"],
  ['Me', "setScreen('me')"], ['My system', "openMySystem()"], ['My home', "v7Sheet(null); openMyHome()"], ['Plan sheet', "v7Sheet('plan', getRecommendation().ranked[1].plan.id)"],
  ['Privacy', "v7Sheet(null); setScreen('privacy')"], ['Solar guide', "setScreen('result'); startSolarGuide()"],
];
// Scans each main screen and sheet with axe against WCAG 2.1 A/AA; any violation fails.
test('no WCAG 2.1 A/AA violations on main screens and sheets', async ({ page }) => {
  test.setTimeout(300000);
  await boot(page, { ...SOLAR, current_screen: 'result' });
  const all = {};
  for (const [name, go] of VIEWS) {
    await page.evaluate((s) => (0, eval)(s), go); await page.waitForTimeout(700);
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const v of r.violations) { if (process.env.D) for (const n of v.nodes.slice(0,8)) console.log('N', name, v.id, n.target.join(' '), (n.any[0]?.message||'').slice(0,120), n.html.slice(0,120)); const k = `${v.id} (${v.impact})`; (all[k] = all[k] || { help: v.help, where: new Set(), n: 0, ex: v.nodes[0]?.target?.join(' ') }); all[k].where.add(name); all[k].n += v.nodes.length; }
  }
  const found = Object.entries(all).map(([k, v]) => `${k}: ${v.help} — ${[...v.where].join(', ')} (e.g. ${v.ex})`);
  expect(found).toEqual([]);
});

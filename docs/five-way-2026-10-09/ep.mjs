import { chromium } from '/home/user/Sawed/node_modules/playwright/index.mjs';
import fs from 'fs';
const c = JSON.parse(process.argv[2]);
const out = c.tag ? `ep_${c.tag}` : `ep_${c.home}_file`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport: { width: 1700, height: 1300 } })).newPage();
const t0 = Date.now(); let clicks = 0;
await p.goto('https://www.energypal.ie/', { waitUntil: 'networkidle', timeout: 60000 });
await p.waitForTimeout(5000);
let f = p.frames().find((x) => /retool/.test(x.url()));
await f.getByText('Find my best plan').first().click(); clicks++;
await p.waitForTimeout(5000);
f = p.frames().find((x) => /energypal_electricity/.test(x.url())) || f;
await f.locator('input[type=file]').first().setInputFiles(c.home + '.csv'); clicks++;
await p.waitForTimeout(8000);
if (c.rural) { await f.getByText('Rural', { exact: true }).first().click(); clicks++; await p.waitForTimeout(1500); }
await f.getByText('Show Results').first().click(); clicks++;
await p.waitForTimeout(15000);
// Planning solar: EnergyPal's own PV and battery simulator, then back to the plans.
const pick = async (id, want) => { const inp = f.locator('#' + id); if ((await inp.inputValue()) === want) return; await inp.click(); clicks++; await p.waitForTimeout(800); await inp.fill(want); await p.waitForTimeout(1200);
  const opt = f.getByRole('option', { name: want, exact: true }); if (await opt.count()) await opt.first().click(); else await inp.press('Enter');
  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(2500); const v = await inp.inputValue(); if (v !== want) console.log('pick', id, 'wanted', want, 'got', v); };
if (c.pv) {
  await f.getByText('☀️ Solar & Battery ☀️', { exact: true }).first().click(); clicks++; await p.waitForTimeout(3000);
  await f.getByText('Enable PV Simulation').first().click(); clicks++; await p.waitForTimeout(3000);
  await pick('select_pv_s1_size--0', c.pv.toFixed(1) + ' kWp');
  await pick('select_pv_s1_orientation--0', c.orient || 'South');
  if (c.batt) { await f.getByText('Enable Battery Simulation').first().click(); clicks++; await p.waitForTimeout(3000); await pick('select_battery_capacity_kwh--0', c.batt.toFixed(1) + ' kWh'); }
  await p.waitForTimeout(5000);
  await p.screenshot({ path: out + '_sim.png' });
  await f.getByText('Plans', { exact: true }).first().click(); clicks++; await p.waitForTimeout(8000);
}
const tick = async (t) => { try { await f.getByText(t, { exact: true }).first().click(); clicks++; await p.waitForTimeout(4000); } catch (e) { console.log('no', t); } };
await tick('Exclude Cash Bonus');
await tick('Show All Plans');
await p.waitForTimeout(4000);
// The table may draw only the rows in view: scroll it through and collect.
const seen = new Map();
for (let i = 0; i < 40; i++) {
  const txt = await f.evaluate(() => document.body.innerText);
  const tail = txt.split('Schedule').slice(1).join('Schedule');
  const lines = tail.split('\n').map((x) => x.trim()).filter(Boolean);
  for (let j = 0; j + 10 < lines.length; j++) {
    if (lines[j + 2] === 'Details' && /^€[\d,.]+$/.test(lines[j + 3])) {
      const row = { s: lines[j], p: lines[j + 1], cost: +lines[j + 3].replace(/[€,]/g, ''), cash: lines[j + 4], disc: lines[j + 5], standing: lines[j + 6], imp: lines[j + 7], exp: lines[j + 8], type: lines[j + 9], sched: lines[j + 10] };
      seen.set(row.s + '|' + row.p + '|' + row.cost, row);
    }
  }
  const moved = await f.evaluate(() => { const els = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY)); let m = false; for (const e of els) { const before = e.scrollTop; e.scrollTop += 600; if (e.scrollTop !== before) m = true; } return m; });
  if (!moved) break;
  await p.waitForTimeout(700);
}
const head = await f.evaluate(() => document.body.innerText.split('Plans\n')[0]);
const rows = [...seen.values()].sort((a, b) => a.cost - b.cost);
fs.writeFileSync(out + '.json', JSON.stringify({ head, rows, clicks, secs: (Date.now() - t0) / 1000 }, null, 1));
await p.screenshot({ path: out + '.png' });
console.log(out, rows.length, 'rows');
await b.close();

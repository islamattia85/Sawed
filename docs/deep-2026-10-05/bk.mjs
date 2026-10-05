import { chromium } from '/home/user/Sawed/node_modules/playwright/index.mjs';
import fs from 'fs';
const c = JSON.parse(process.argv[2]);
const out = `bk_${c.home}_${c.mode}.txt`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--headless=new'] });
const p = await b.newPage({ viewport: { width: 1200, height: 1000 } });
let clicks = 0; const t0 = Date.now();
const wait = (ms = 800) => p.waitForTimeout(ms);
const radio = async (v, name) => { const sel = name ? `input[name="${name}"][value="${v}"]` : `input[value="${v}"]`; await p.locator(sel).first().check({ force: true }); clicks++; await wait(); };
const lab = async (sel) => { if (!(await p.locator(sel).count())) return; const id = await p.locator(sel).first().getAttribute('id'); await p.locator(`label[for="${id}"]`).first().click(); clicks++; await wait(); };
await p.goto('https://www.bonkers.ie/compare-gas-electricity-prices/electricity/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await wait(3000);
try { await p.getByRole('button', { name: /accept all|accept/i }).first().click({ timeout: 2500 }); } catch {}
await p.locator('label:has-text("Continue without upload")').first().click(); clicks++; await wait();
await radio(c.legacy ? 'electric-ireland' : 'pinergy');
await radio(c.region || 'URBAN', 'region');
await radio(c.legacy ? 'legacy' : 'smart', 'meter_type');
if (c.legacy) await lab('input[name=nightsaver][value=false]');
await radio('DD', 'payment_type');
await p.locator('select[name=electricity_plan]').selectOption({ index: 1 }); clicks++; await wait();
const started = p.locator('[name=electricity_plan_started]');
if (await started.count()) {
  const tag = await started.first().evaluate((e) => e.tagName + ':' + e.type);
  console.log('plan_started field', tag);
  if (tag.startsWith('SELECT')) await started.first().selectOption({ index: 1 }); else { try { await lab('input[name=electricity_plan_started][value=false]'); } catch {} try { await started.first().fill('2024-01-01'); } catch {} }
  clicks++; await wait();
}
if (c.mode === 'kwh') {
  await radio('KNOWN_CONSUMPTION', 'consumption_type_electricity');
  await p.locator('input[name=electricity_consumption]').fill(String(c.kwh)); clicks++;
  if (c.export) {
    await lab('input[name=export_electricity][value=true]');
    const ex = p.locator('main input[type=number]').nth(1); await ex.fill(String(c.export)); clicks++;
  } else await lab('input[name=export_electricity][value=false]');
} else {
  await radio('HDF_UPLOAD', 'consumption_type_electricity'); await wait(1500);
  await p.locator('input[type=file]').first().setInputFiles(c.home + '.csv'); clicks++; await wait(9000);
  await lab('input[name=export_electricity][value=' + (c.export ? 'true' : 'false') + ']');
}
const warn = /incomplete/.test(await p.evaluate(() => document.body.innerText));
await lab(`input[name=ev_optimised][value=${c.ev ? 'true' : 'false'}]`);
await lab('input[name=cashback][value=false]'); await lab('input[name=signup][value=false]');
await p.getByRole('button', { name: /Compare prices/ }).first().click(); clicks++;
try { await p.waitForURL(/your-results/, { timeout: 30000 }); } catch (e) { const t = await p.evaluate(() => [...document.querySelectorAll('[class*=error], [role=alert], .invalid-feedback')].map((x) => x.innerText).filter(Boolean).join(' / ')); console.log('FORM ERRORS:', t); console.log(await p.$$eval('main input:checked, main select', (els) => els.map((e) => e.name + '=' + e.value).join(' '))); throw e; } await wait(6000);
for (let i = 0; i < 6; i++) { const m = p.getByRole('button', { name: /Show \d+ more results/ }); if (!(await m.count())) break; await m.first().click(); await wait(3000); }
fs.writeFileSync(out, await p.evaluate(() => (document.querySelector('main') || document.body).innerText));
fs.writeFileSync(out.replace('.txt', '.meta.json'), JSON.stringify({ clicks, secs: (Date.now() - t0) / 1000, warn }));
console.log(out, clicks, warn);
await b.close();

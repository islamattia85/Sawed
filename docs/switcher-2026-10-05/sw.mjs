import { chromium } from '/home/user/Sawed/node_modules/playwright/index.mjs';
import fs from 'fs';
const c = JSON.parse(process.argv[2]);
const out = `sw_${c.home}_${c.mode}.txt`;
const E = 'comparison[electricity]';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--headless=new'] });
const p = await b.newPage({ viewport: { width: 1200, height: 1000 } });
let clicks = 0; const t0 = Date.now();
const pick = async (name, value) => { const id = await p.locator(`input[name="${name}"][value="${value}"]`).first().getAttribute('id'); const l = p.locator(`label[for="${id}"]`).first(); if (await l.isVisible()) { await l.click(); clicks++; } await p.waitForTimeout(900); };
await p.goto('https://switcher.ie/gas-electricity/comparison/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(4000);
try { await p.getByText('ACCEPT ALL').first().click({ timeout: 2500 }); } catch {}
await pick('comparison_type[fuel_type]', 'electricity');
await pick(`${E}[current_supplier]`, c.legacy ? 'electric-ireland' : 'pinergy');
if (c.region === 'RURAL') await pick(`${E}[location]`, 'rural');
if (c.legacy) await pick(`${E}[meter_type]`, 'twenty_four_hour');
if (c.mode === 'kwh') {
  await pick(`${E}[consumption][calculation_type]`, 'kwh');
  await p.locator(`[name="${E}[consumption][kwh_value]"]`).fill(String(c.kwh)); clicks++;
} else {
  await pick(`${E}[consumption][calculation_type]`, 'load_profile');
  await p.locator('input[name="comparison[electricity][consumption][load_profile]"]').setInputFiles(c.home + '.csv'); clicks++; await p.waitForTimeout(10000);
}
if (c.export && c.mode === 'kwh') { await pick(`${E}[export][has_export]`, 'true'); await p.locator(`[name="${E}[export][kwh_value]"]`).fill(String(c.export)); clicks++; }
else if (c.export) await pick(`${E}[export][has_export]`, 'true');
await pick(`${E}[search_type]`, 'all');
await pick(`${E}[include_cashback]`, '0');
const pre = await p.evaluate(() => document.body.innerText);
await p.getByRole('button', { name: /Find cheaper deals/i }).first().click(); clicks++;
try { await p.waitForURL(/results/, { timeout: 45000 }); } catch (e) { console.log('NO RESULTS', (await p.evaluate(() => [...document.querySelectorAll('.error, .invalid-feedback, [class*=error]')].map((x) => x.innerText).filter(Boolean).join(' / ')))); fs.writeFileSync(out + '.pre', pre); await p.screenshot({ path: out + '.png', fullPage: true }); throw e; }
await p.waitForTimeout(7000);
for (let i = 0; i < 10; i++) { const m = p.getByRole('button', { name: /show more|load more|more plans/i }); if (!(await m.count()) || !(await m.first().isVisible())) break; await m.first().click(); await p.waitForTimeout(3000); }
fs.writeFileSync(out, await p.evaluate(() => document.body.innerText));
fs.writeFileSync(out.replace('.txt', '.meta.json'), JSON.stringify({ clicks, secs: (Date.now() - t0) / 1000 }));
console.log(out, clicks);
await b.close();

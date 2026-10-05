import { chromium } from '/home/user/Sawed/node_modules/playwright/index.mjs';
import fs from 'fs';
const [file, out] = [process.argv[2], process.argv[3]];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--headless=new'] });
const p = await b.newPage({ viewport: { width: 1200, height: 1000 } });
const t0 = Date.now(); let clicks = 0;
const lab = async (sel) => { if (!(await p.locator(sel).count())) return; const id = await p.locator(sel).first().getAttribute('id'); await p.locator(`label[for="${id}"]`).first().click(); clicks++; await p.waitForTimeout(700); };
await p.goto('https://www.bonkers.ie/compare-gas-electricity-prices/electricity/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(3000);
try { await p.getByRole('button', { name: /accept all|accept/i }).first().click({ timeout: 2500 }); } catch {}
await p.locator('label:has-text("Continue without upload")').first().click(); clicks++; await p.waitForTimeout(800);
for (const v of ['pinergy','URBAN','smart','DD']) { await p.locator(`input[value="${v}"]`).first().check({ force: true }); clicks++; await p.waitForTimeout(800); }
await p.locator('select[name=electricity_plan]').selectOption({ index: 1 }); clicks++; await p.waitForTimeout(800);
if (file === 'kwh') {
  await p.locator('input[value="KNOWN_CONSUMPTION"]').first().check({ force: true }); clicks++; await p.waitForTimeout(800);
  await p.locator('input[name=electricity_consumption]').fill(process.argv[4]); clicks++;
} else {
  await p.locator('input[value="HDF_UPLOAD"]').first().check({ force: true }); clicks++; await p.waitForTimeout(1500);
  const inp = p.locator('input[type=file]'); console.log('file inputs', await inp.count());
  await inp.first().setInputFiles(file); clicks++; await p.waitForTimeout(8000);
  console.log((await p.evaluate(() => (document.querySelector('main')||document.body).innerText)).split('How much electricity do you use?')[1]?.slice(0,1200));
}
await lab('input[name=export_electricity][value=false]'); await lab(`input[name=ev_optimised][value=${process.env.EV ? 'true' : 'false'}]`);
await lab('input[name=cashback][value=false]'); await lab('input[name=signup][value=false]');
await p.getByRole('button', { name: /Compare prices/ }).first().click(); clicks++;
await p.waitForURL(/your-results/, { timeout: 90000 }); await p.waitForTimeout(6000);
const tAnswer = (Date.now() - t0) / 1000;
for (let i = 0; i < 6; i++) { const n = await p.evaluate(() => { const bs = [...document.querySelectorAll('button, a')].filter((e) => /Show \d+ more results/.test(e.textContent)); bs.forEach((e) => e.click()); return bs.length; }); console.log('more', n, 'cards', await p.getByText('Estimated 1-year cost').count()); if (!n) break; await p.waitForTimeout(8000); }
await p.screenshot({ path: 'after.png', fullPage: false }); fs.writeFileSync(out, await p.evaluate(() => (document.querySelector('main') || document.body).innerText));
console.log(JSON.stringify({ clicks, seconds: tAnswer }));
await p.getByText('See details & calculations').first().click(); await p.waitForTimeout(4000);
fs.writeFileSync(out.replace('.txt','_det.txt'), await p.evaluate(() => document.body.innerText));
await b.close();

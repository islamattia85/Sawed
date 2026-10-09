import { chromium } from '/home/user/Sawed/node_modules/playwright/index.mjs';
import fs from 'fs';
const c = JSON.parse(process.argv[2]);
const out = c.tag ? `kw_${c.tag}` : `kw_${c.home}_${c.mode}`;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--headless=new'] });
const p = await b.newPage({ viewport: { width: 1200, height: 1000 } });
let clicks = 0; let warn = null; const t0 = Date.now(); const wait = (ms = 900) => p.waitForTimeout(ms);
const radio = async (n, v) => { await p.locator(`input[name="${n}"][value="${v}"]`).first().check({ force: true }); clicks++; await wait(); };
const toggle = async (t) => { await p.locator('main').getByText(t, { exact: true }).locator('visible=true').first().click(); clicks++; await wait(1200); };
// Fill the number input that follows a visible label text.
const near = async (t, v) => {
  const ok = await p.evaluate(([t, v]) => {
    const els = [...document.querySelectorAll('main *')].filter((e) => e.offsetParent && e.childElementCount === 0 && (e.textContent || '').trim().startsWith(t));
    for (const e of els) { let n = e; for (let i = 0; i < 4 && n; i++, n = n.parentElement) { const inp = n.querySelector('input[type=number]'); if (inp && inp.offsetParent) { inp.focus(); inp.value = String(v); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); inp.blur(); return true; } } }
    return false; }, [t, v]);
  if (!ok) console.log('no field for', t); clicks++; await wait(1200);
};
const tickNear = async (t) => { const l = p.locator('main label', { hasText: t }).locator('visible=true').first(); if (await l.count()) { const inp = l.locator('input[type=checkbox]'); if (!(await inp.isChecked().catch(() => false))) await l.click(); clicks++; await wait(); } else console.log('no tick for', t); };
await p.goto('https://kilowatt.ie/electricity-price-comparison/?fuel=elec', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await wait(3000);
await radio('basics_fuel_type_radio', 'elec');
await radio('basics_meter_type_radio', c.legacy ? '24h' : 'Smart');
if (!c.legacy) await radio('basics_current_tariff_radio', 'Smart');
await radio('basics_location_type_radio', c.rural ? 'Rural' : 'Urban');
await radio('basics_tariff_type_radio', 'standard');
if (c.mode === 'kwh') {
  await radio('usage_source_radio', 'annual_kwh');
  { const inp = p.locator('main input[type=number]').locator('visible=true').nth(1); await inp.fill(String(c.kwh)); await inp.press('Tab'); clicks++; await wait(2500);
    console.log('annual now', await inp.inputValue()); }
} else {
  await radio('usage_source_radio', 'smart_meter');
  await p.locator('main input[type=file]').first().setInputFiles(c.home + '.csv'); clicks++; await wait(8000);
  // A file with export readings gets a 'missing data' warning: go on with the file, as a user would.
  const go = p.locator('main').getByText('Continue with smart meter data', { exact: true }).locator('visible=true');
  if (await go.count()) { warn = (await p.evaluate(() => ((document.querySelector('main') || document.body).innerText.match(/has ([\d.]+)% missing data/) || [])[1])) || true; await go.first().click(); clicks++; await wait(4000); }
}
if (c.ev) { await toggle('EV charger'); if (c.mode === 'kwh') await tickNear('EV charging already included'); await near('Average kWh charged per night', c.ev); }
const setId = async (id, v) => { const inp = p.locator('#' + id); await inp.fill(String(v)); await inp.press('Tab'); clicks++; await wait(2500); console.log(id, await inp.inputValue()); };
if (c.solar) { await toggle('Solar panels'); await setId('solar_capacity_kwp', c.solar); }
if (c.batt) { await toggle('Home battery'); await setId('battery_capacity_kwh', c.batt);
  if (c.smart === 0) { const sc = p.locator('#battery_smart_control'); if (await sc.isChecked()) { await sc.uncheck({ force: true }); clicks++; await wait(2500); } console.log('smart control', await sc.isChecked()); } }
if (c.hp) { await toggle('Heat pump'); await tickNear('Heat pump already included'); if (c.hp_area) await near('Heated floor area', c.hp_area); }
await wait(5000);
await p.waitForSelector('#resultsList .kw-epc-tariff-card', { timeout: 45000 }).catch(() => console.log('no cards yet'));
await wait(1500);
const secs = (Date.now() - t0) / 1000;
const page = await p.evaluate(() => (document.querySelector('main') || document.body).innerText);
const cards = await p.$$eval('#resultsList .kw-epc-tariff-card:not(.kw-epc-tariff-card--solar)', (cs) => cs.map((c) => {
  const t = (c.textContent || '').replace(/\s+/g, ' ');
  const m = t.match(/Est\. 1-year cost\s*€\s*([\d,.]+)/);
  const nm = c.querySelector('.kw-epc-tariff-card__name');
  return { s: (c.querySelector('.kw-epc-tariff-card__logo') || {}).alt || '', p: ((nm && nm.textContent) || '').trim(), cost: m ? +m[1].replace(/,/g, '') : null, text: t.slice(0, 1200) };
}));
fs.writeFileSync(out + '.json', JSON.stringify({ clicks, secs, warn, n: cards.length, cards, summary: (page.match(/\d+ tariffs found[^\n]*/) || [''])[0], notes: page.split('Results')[0].slice(-1500) }));
console.log(out, clicks, cards.length, cards[0] && cards[0].s, cards[0] && cards[0].p, cards[0] && cards[0].cost);
await b.close();

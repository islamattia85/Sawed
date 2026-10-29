import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { boot, isolate, esbKwFile } from './support.js';

/**
 * What the owner saw on peakless.ie on a phone (29 Oct 2026): the car
 * questions' cards ran their words under the tick ("8k km" over two lines,
 * "Family" behind the ring), the distance box read "e.g. 120" for
 * "e.g. 12000", the summary said "Solar: Solar", and the website had no way
 * to share an answer or download the report. And after setting up a home
 * whose meter file showed its panels, the share card said "€1,598 less a
 * year": the plan it is on, priced without those panels, against the
 * cheapest plan with them.
 */
/** Setup from the start, in the app ('/app') or on the website ('/'), where the photos were taken. */
const fresh = async (page, path = '/app') => {
  await isolate(page);
  await page.goto(`${path}?fresh`);
  await page.waitForFunction(() => window.__bootSettled === true);
  await page.evaluate(() => window.startFlow('full'));
};

/** Answer whatever setup asks until it asks `stop`. */
const toQuestion = (page, stop, answers) => page.evaluate(([stop, ans]) => {
  for (let i = 0; i < 40; i++) {
    const sec = document.querySelector('.fl-q'), el = sec && sec.querySelector('[data-q]');
    const m = !el && sec && sec.innerHTML.match(/flowAnswer\('(\w+)'/), q = el ? el.dataset.q : m ? m[1] : null;
    if (!q || q === stop) return q;
    window.flowAnswer(q, ans[q] ?? 'no');
  }
  return null;
}, [stop, answers]);

const ANS = { bill: 140, plan: 'EI-24', disc: 0, meter: 'smart', area: 'urban', heat: 'gas', heattime: 'day', gas: 'no', night: 'no', where: 'east', house: 'semi' };
const QUESTIONS = [
  ['heat', {}],
  ['roof', { solar: 'have' }],
  ['km', { solar: 'no', ev: 'have' }],
  ['car', { solar: 'no', ev: 'have', km: 16000 }],
];

for (const [where, path] of [['the website', '/'], ['the app', '/app']]) {
  for (const width of [393, 320]) {
    test(`setup on ${where}, ${width} px wide: heating, roof, distance and car cards keep each line of words whole and clear of the tick`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const bad = [];
      for (const [q, extra] of QUESTIONS) {
        await fresh(page, path);
        expect(await toQuestion(page, q, { ...ANS, ...extra })).toBe(q);
        bad.push(...await page.evaluate((q) => [...document.querySelectorAll(`.fl-q .fl-opt[data-q="${q}"]`)].flatMap((o) => {
          const c = o.getBoundingClientRect(), a = getComputedStyle(o, '::after');
          const tw = parseFloat(a.width), th = parseFloat(a.height);
          const tl = c.right - parseFloat(a.right) - tw, tt = c.top + parseFloat(a.top) + parseFloat(a.marginTop);
          const hits = (r) => r.left < tl + tw && r.right > tl && r.top < tt + th && r.bottom > tt;
          return [...o.querySelectorAll('b, small')].flatMap((w) => {
            const rs = [...w.getClientRects()], name = `${q} ${o.dataset.v} "${w.textContent}"`;
            return [
              ...(w.tagName === 'B' && rs.length !== 1 ? [`${name} runs over ${rs.length} lines`] : []),
              ...(rs.some(hits) ? [`${name} runs under the tick`] : []),
              ...(rs.some((r) => r.right > c.right - 1 || r.left < c.left + 1) ? [`${name} runs off the card`] : []),
            ];
          });
        }), q));
      }
      expect(bad).toEqual([]);
    });
  }
}

test('setup: the distance box shows its whole hint, "e.g. 12000"', async ({ page }) => {
  await fresh(page, '/');
  expect(await toQuestion(page, 'km', { ...ANS, solar: 'no', ev: 'have' })).toBe('km');
  const r = await page.evaluate(() => {
    const i = /** @type {HTMLInputElement} */ (document.getElementById('flow-own-km')), cs = getComputedStyle(i);
    const x = document.createElement('canvas').getContext('2d');
    x.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return { hint: i.placeholder, needs: x.measureText(i.placeholder).width, room: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
  });
  expect(r.hint).toBe('e.g. 12000');
  expect(r.needs, JSON.stringify(r)).toBeLessThanOrEqual(r.room);
});

test('setup: panels already up read "Panels on the roof", not "Solar: Solar"', async ({ page }) => {
  await fresh(page, '/');
  expect(await toQuestion(page, 'roof', { ...ANS, solar: 'have' })).toBe('roof');
  const row = page.locator('.fl-sofar > div', { hasText: /^Solar/ });
  await expect(row.locator('b')).toHaveText('Panels on the roof');
});

for (const [name, size] of [['a phone', { width: 393, height: 851 }], ['a computer', { width: 1440, height: 900 }]]) {
  test(`the website on ${name}: the answer offers Download report and Share, and Share opens the picture to send`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors = await boot(page, {}, '/');
    await page.evaluate(() => window.setScreen('result'));
    await expect(page.locator('.web-dash')).toHaveCount(1);
    const take = page.locator('.hm-take');
    await expect(take.getByRole('button', { name: /Download report/ })).toBeVisible();
    await take.getByRole('button', { name: /Share/ }).click();
    await expect(page.getByRole('heading', { name: 'Your figures as a picture' })).toBeVisible();
    await expect(page.locator('.sh-preview')).toBeVisible();
    // The doors the dashboard stands in for stay gone.
    await expect(page.locator('.ax-doors')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test.describe('a home with panels', () => {
  // The service worker would serve the report's typeface past the block below.
  test.use({ serviceWorkers: 'block' });
test('panels found in the meter file and confirmed: the share card and the report give Home\'s saving, the switch alone', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await fresh(page, '/');
  // The report in the PDF's own faces, so its words can be read back from the
  // file. Added after the page's own routes, so it is the one asked first.
  await page.route('**/assets/fonts-*.js', (r) => r.abort());
  await page.locator('.fl-upload input[type=file]').setInputFiles({ name: 'esb.csv', mimeType: 'text/csv',
    buffer: Buffer.from(esbKwFile('2026-09-30', 365, '2026-04-01')) });
  await page.getByRole('button', { name: /use this data/i }).click();
  // As the owner went: thinking about solar, then "Yes, I have panels" when the file showed them.
  expect(await toQuestion(page, null, { ...ANS, solar: 'thinking', fileexp: 'have', filewhen: 'sinceyes', plan: 'EN-EVSD', heat: 'heatpump',
    roof: 'S', tilt: 35, panels: 10, battery: 9, price: 11200, grant: 'no', ev: 'thinking', km: 16000, car: 17 })).toBe(null);
  const f = await page.evaluate(() => {
    const st = window.state;
    window.flowFinish(); window.setScreen('result');
    const rec = window.getRecommendation();
    return {
      flags: [st.has_solar, !!st.solar_planned, !!st.solar_is_estimate],
      home: +document.querySelector('[data-countup]').dataset.countup,
      share: +window.__shareText(false).match(/€([\d,]+) a year less/)[1].replace(/,/g, ''),
      withoutPanels: Math.round(window.__sim.baselineNet() - rec.best.net),
    };
  });
  expect(f.flags).toEqual([true, false, false]);
  expect(f.share).toBe(f.home);
  // The panels' own worth is not a saving from switching.
  expect(f.withoutPanels - f.home, JSON.stringify(f)).toBeGreaterThan(300);

  const download = page.waitForEvent('download', { timeout: 45_000 });
  await page.evaluate(() => window.doGeneratePdf(''));
  const file = await download;
  const path = testInfo.outputPath('report.pdf');
  await file.saveAs(path);
  const raw = readFileSync(path).toString('latin1');
  const m = raw.match(/a year less than now/) && raw.match(/Switch to [^)]*?: \x80([\d,]+) a year less than now/);
  expect(m, 'the report states the switch and its saving').toBeTruthy();
  expect(Math.abs(+m[1].replace(/,/g, '') - f.home)).toBeLessThanOrEqual(1);
});
});

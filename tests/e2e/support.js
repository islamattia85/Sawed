/**
 * Shared end-to-end helpers.
 *
 * The app can request Google Fonts and Vercel's page counter (the counter only
 * after a yes to usage counts). Neither affects
 * behaviour, but both gate `load`, so on a network where they are unreachable
 * every page load stalls until the request times out — around 13 seconds each,
 * which pushed tests past their budget for reasons that had nothing to do with
 * the code under test.
 *
 * Blocking them makes the suite hermetic: it tests the application, not the
 * reachability of a third-party CDN, and runs at the same speed everywhere.
 */

const BLOCKED = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  '/_vercel/',
  'supabase.co',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
];

/** Install request blocking. Call once per page, before the first navigation. */
export async function isolate(page) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (BLOCKED.some((b) => url.includes(b))) return route.abort();
    return route.continue();
  });
}

/** Collect uncaught page errors for assertion at the end of a test. */
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

export const SETUP = {
  onboarding_complete: true,
  seen_intro: true,
  current_screen: 'result',
  bimonthly_bill_eur: 250,
  heating_type: 'gas',
  region: 'east',
  baseline: 'EI-24',
  baseline_known: true,
  has_solar: true,
  considering_solar: true,
  count_A: 12,
  azimuth_A: 180,
  tilt_A: 35,
  panel_w: 440,
  battery_kwh: 5,
  install_cost: 12000,
  grant_seai: 1800,
};

/** Boot the app with a known state and wait until the shell is interactive. */
export async function boot(page, overrides = {}, path = '/app') {
  await isolate(page);
  const errors = collectErrors(page);
  await page.goto(path);
  // The usage-measurement question is answered "no" unless a test is about
  // that question (askConsent: true); its bar would otherwise sit over the
  // buttons other tests tap.
  const { askConsent, ...state } = overrides;
  await page.evaluate(
    ([s, ask]) => {
      localStorage.setItem('solarAppState_v2', JSON.stringify(s));
      if (ask) localStorage.removeItem('sawed_analytics'); else localStorage.setItem('sawed_analytics', 'no');
    },
    [{ ...SETUP, ...state }, !!askConsent],
  );
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loader'));
  // The app paints on the rates embedded in the bundle, then swaps to the
  // served tariffs.json — a full re-render about 250ms in. Grabbing a node
  // before that lands gives "element is not attached to the DOM", which is a
  // real defect seen from the outside but makes every test that clicks
  // something a coin flip. Wait for boot to settle.
  await page.waitForFunction(() => window.__bootSettled === true, null, { timeout: 10_000 });
  // Analytics' folds open closed on every visit, and nothing claims the
  // reader came from Home; the open sheet and Analytics tab are not kept
  // across a load either. Tests that need any of them set it again here.
  const again = Object.fromEntries(['_solar_more', '_an_day_open', '_an_from', '_an_tab', '_sheet']
    .filter((k) => k in state).map((k) => [k, state[k]]));
  if (Object.keys(again).length) await page.evaluate((f) => { Object.assign(window.state, f); window.renderApp(); }, again);
  return errors;
}

/**
 * An ESB 30-minute kW file, `days` long, ending on `last`: the same use every
 * day, and from `panels` (if given) panels selling 2.5 kW from 10am to 4pm.
 */
export function esbKwFile(last, days, panels) {
  const rows = ['MPRN,Meter Serial Number,Read Value,Read Type,Read Date and End Time'];
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (t) => `${pad(t.getUTCDate())}-${pad(t.getUTCMonth() + 1)}-${t.getUTCFullYear()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  const end = Date.parse(last + 'T00:00:00Z') + 864e5;
  for (let i = days * 48 - 1; i >= 0; i--) {
    const t = new Date(end - (days * 48 - i - 1) * 18e5 - 18e5 + 18e5);
    const startHour = new Date(t.getTime() - 18e5).getUTCHours(), day = new Date(t.getTime() - 18e5).toISOString().slice(0, 10);
    const use = startHour < 7 ? 0.3 : startHour >= 17 && startHour < 22 ? 1.2 : 0.6;   // kW
    const sun = panels && day >= panels && startHour >= 10 && startHour < 16;
    rows.push(`10000000000,000000000000000000,${(sun ? 0.1 : use).toFixed(3)},Active Import Interval (kW),${stamp(t)}`);
    if (panels) rows.push(`10000000000,000000000000000000,${(sun ? 2.5 : 0).toFixed(3)},Active Export Interval (kW),${stamp(t)}`);
  }
  return rows.join('\n');
}

/** Add a meter file through the meter sheet, replacing any file already there. */
export async function uploadMeterFile(page, name, text) {
  await page.evaluate(() => { window.state._sheet = null; window.renderApp(); window.v7Sheet('meter'); });
  const replace = page.getByRole('button', { name: /Replace the file/ });
  if (await replace.count()) await replace.click();
  await page.locator('#csv-file-input').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.waitForFunction(() => /Imported/.test(document.querySelector('#csv-parse-result')?.innerText || ''), null, { timeout: 30000 });
}

/** Boot with no stored state at all, for first-run flows. */
export async function bootFresh(page) {
  await isolate(page);
  const errors = collectErrors(page);
  await page.goto('/app');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loader'));
  return errors;
}

/**
 * Shared end-to-end helpers.
 *
 * The app requests Google Fonts and Vercel analytics at load. Neither affects
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
export async function boot(page, overrides = {}) {
  await isolate(page);
  const errors = collectErrors(page);
  await page.goto('/');
  await page.evaluate(
    (s) => localStorage.setItem('solarAppState_v2', JSON.stringify(s)),
    { ...SETUP, ...overrides },
  );
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loader'));
  return errors;
}

/** Boot with no stored state at all, for first-run flows. */
export async function bootFresh(page) {
  await isolate(page);
  const errors = collectErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loader'));
  return errors;
}

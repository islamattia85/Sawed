import { test, expect } from '@playwright/test';
import { boot } from './support.js';

/**
 * The product's whole claim is independence and current rates. These tests
 * assert it cannot say anything about its own data that isn't true.
 *
 * All three of these shipped at once: the scraper matched one plan in twenty-six
 * and finished green, the staleness banner keyed on the newest verification date
 * so that one plan silenced the alarm for the other twenty-five, and the result
 * screen printed "all 25 live plans checked" against today's date while most had
 * not been checked in eight weeks.
 */

/** Age in days of the oldest and newest recommendable plan, from live data. */
const ages = (page) => page.evaluate(() => {
  const ds = window.TARIFFS
    .filter((t) => !t.discontinued && t.verified_date)
    .map((t) => t.verified_date).sort();
  const age = (d) => Math.floor((Date.now() - new Date(d)) / 864e5);
  return { oldest: age(ds[0]), newest: age(ds[ds.length - 1]), count: ds.length };
});

test('freshness is reported from the oldest plan, never the newest', async ({ page }) => {
  await boot(page, { current_screen: 'plans' });
  const a = await ages(page);

  const label = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.plan-verified')]
      .find((e) => /Rates verified/i.test(e.textContent));
    return el ? el.textContent.trim() : null;
  });
  expect(label, 'no freshness label on the plans screen').not.toBeNull();

  // Whatever date it shows must be at least as old as the oldest plan. A label
  // quoting the newest date would understate the age of the set.
  const shown = await page.evaluate((txt) => {
    const m = txt.match(/(\d{1,2} \w{3} \d{4})/);
    return m ? Math.floor((Date.now() - new Date(m[1])) / 864e5) : null;
  }, label);
  expect(shown, `label "${label}" carries no date`).not.toBeNull();
  expect(shown, `label understates age: shows ${shown}d, oldest plan is ${a.oldest}d`)
    .toBeGreaterThanOrEqual(a.oldest - 1);
});

test('the staleness banner fires when any recommendable plan is over 45 days old', async ({ page }) => {
  await boot(page, { current_screen: 'plans' });
  const a = await ages(page);
  const banner = await page.locator('.staleness-banner').count();

  if (a.oldest > 45) {
    expect(banner, `oldest plan is ${a.oldest} days old but no banner is shown`).toBeGreaterThan(0);
    await expect(page.locator('.staleness-banner')).toContainText(/not re-checked recently/i);
  } else {
    expect(banner, `all plans are fresh (oldest ${a.oldest}d) but a banner is shown`).toBe(0);
  }
});

test('the result screen never claims every plan was checked when they were not', async ({ page }) => {
  await boot(page);
  const a = await ages(page);
  const text = await page.evaluate(() => document.body.innerText);

  if (a.oldest > 45) {
    expect(text, 'stale data is being presented as a clean bill of health')
      .not.toMatch(/Every plan re-checked/i);
    // The age must be legible on the default view — not behind a disclosure,
    // and not softened to "recently". It used to be a five-line amber banner
    // above the answer; it is now a chip below it. Either is honest. Silence,
    // or a figure the reader has to go looking for, is not.
    const chip = page.locator('.fresh-chip');
    await expect(chip, 'nothing on the result screen discloses the rate age').toBeVisible();
    await expect(chip, 'the staleness is disclosed without saying how stale')
      .toContainText(/\d+ days ago/i);
    await expect(chip).toHaveClass(/is-stale/);
  } else {
    await expect(page.locator('.fresh-chip')).not.toHaveClass(/is-stale/);
  }
});

test('no screen offers a control that cannot work in this deployment', async ({ page }) => {
  await boot(page, { current_screen: 'settings' });
  // The refresh API does not exist on a static deploy; the button must not be
  // offered until something has confirmed one is there.
  const btn = await page.locator('#tariff-refresh-btn').count();
  const flag = await page.evaluate(() => window.state._refresh_api_available);
  if (flag !== true) expect(btn, 'live-refresh button shown with no API behind it').toBe(0);
});

test('an unknown screen is reported rather than silently rendering home', async ({ page }) => {
  const errors = [];
  await boot(page);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.evaluate(() => { window.setScreen('this-screen-does-not-exist'); });
  expect(errors.join(' '), 'a mistyped screen name fell through in silence')
    .toMatch(/unknown screen/i);
  // …and the user still lands somewhere usable.
  expect(await page.evaluate(() => window.state.current_screen)).toBe('result');
});

test('nothing promises to send data the app cannot send', async ({ page }) => {
  await boot(page);
  const text = await page.evaluate(() => {
    // Sweep every screen's rendered copy for undeliverable promises.
    const screens = ['result', 'plans', 'solar', 'monitor', 'more', 'quotes', 'how-to-switch', 'independence'];
    let all = '';
    for (const s of screens) { window.state.current_screen = s; window.renderApp(); all += `\n${document.body.innerText}`; }
    return all;
  });
  expect(text, 'promises installer matching that no code performs').not.toMatch(/within 24h|within 48h/i);
  expect(text, 'claims a referral fee that no affiliate link earns').not.toMatch(/earn a (small )?referral fee|may earn a commission/i);
});

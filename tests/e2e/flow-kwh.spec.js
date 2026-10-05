import { test, expect } from '@playwright/test';

test('the first question takes usage in kWh as well as a bill in euro', async ({ page }) => {
  await page.goto('/?fresh'); await page.waitForFunction(() => window.__bootSettled === true);
  await page.evaluate(() => window.startFlow('quick'));
  await page.getByRole('button', { name: 'My usage in kWh' }).click();
  await page.locator('#flow-bill').fill('5300');
  await page.getByRole('button', { name: 'Next' }).click();
  const st = await page.evaluate(() => ({ m: window.state.usage_input_mode, k: window.state.annual_kwh }));
  expect(st).toEqual({ m: 'kwh', k: 5300 });
  await expect(page.locator('.fl')).toContainText('5,300 kWh a year');
});

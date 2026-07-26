import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled in CI images at PLAYWRIGHT_BROWSERS_PATH.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    // Some environments ship a preinstalled Chromium whose build number does
    // not match this Playwright release. Point at it with PW_CHROMIUM_PATH
    // rather than downloading a second copy; unset falls back to the managed
    // browser, which is what CI uses.
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: 'mobile', use: { ...devices['Pixel 5'] } }],
  // Tests run against the real production bundle, not the dev server.
  webServer: {
    // --host 127.0.0.1 is load-bearing: vite preview defaults to `localhost`,
    // which resolves to ::1 first on GitHub runners, so polling 127.0.0.1
    // never connects and the server appears to never start.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

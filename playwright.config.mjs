import { defineConfig, devices } from '@playwright/test';

// Two halves, described in docs/WEB.md:
//  - `desktop` runs against the exported static bundle alone and touches no
//    backend, so it is safe to run anywhere and is what `npm run e2e` runs.
//  - `desktop-live` signs in to a real, freshly created consumer account and
//    drives the signed-in surfaces. It only exists when NEWONE_WEB_E2E_LIVE=1
//    (`npm run e2e:live`), because it creates real accounts on the hosted
//    project.
const live = process.env.NEWONE_WEB_E2E_LIVE === '1';
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } };

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // One worker in a live run: each worker would otherwise create its own
  // set of real accounts.
  workers: live ? 1 : process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run e2e:serve',
    url: 'http://127.0.0.1:4173/sign-in',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: '**/live/**',
      use: desktop,
    },
    // The phone layout of the one screen a phone browser actually lands on.
    {
      name: 'mobile-chromium',
      testMatch: '**/auth.spec.mjs',
      use: { ...devices['Pixel 7'] },
    },
    ...(live
      ? [{
          name: 'desktop-live',
          testMatch: '**/live/**/*.spec.mjs',
          // Real signups, a real gateway and a real sign-in per test.
          timeout: 180_000,
          use: desktop,
        }]
      : []),
  ],
});

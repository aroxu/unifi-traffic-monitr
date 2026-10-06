import {defineConfig, devices} from '@playwright/test';

// The setup project signs in once through the login form. Other projects
// reuse that session, which also stays under the sign-in rate limit.
export const authFile = 'test-results/.auth/admin.json';

export default defineConfig({
  testDir: './e2e',
  retries: 0,
  reporter: 'list',
  use: {baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001', trace: 'retain-on-failure'},
  projects: [
    {name: 'setup', testMatch: /auth\.setup\.ts/},
    {name: 'desktop-chromium', dependencies: ['setup'],
      use: {...devices['Desktop Chrome'], viewport: {width: 1440, height: 900}, storageState: authFile}},
    {name: 'mobile-chromium', dependencies: ['setup'],
      use: {...devices['Desktop Chrome'], viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, storageState: authFile}}
  ]
});

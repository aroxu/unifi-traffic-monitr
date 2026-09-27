import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  retries: 0,
  reporter: 'list',
  use: {baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001', trace: 'retain-on-failure',
    storageState: process.env.E2E_AUTH_STATE || undefined},
  projects: [
    {name: 'desktop-chromium', use: {...devices['Desktop Chrome'], viewport: {width: 1440, height: 900}}},
    {name: 'mobile-chromium', use: {...devices['Desktop Chrome'], viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}}
  ]
});

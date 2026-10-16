import { defineConfig } from '@playwright/test';

// One worker, one server: the specs read the committed page and never change it.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  timeout: 45_000,
  workers: 1,
  reporter: [['list']],
  outputDir: process.env.E2E_OUT ?? 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1100, height: 720 },
    video: 'off',
  },
  webServer: {
    command: 'node serve.mjs',
    url: 'http://127.0.0.1:4173/benchmarks/',
    reuseExistingServer: false,
    timeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

'use strict';

// Phase-04 Playwright config. Driven by validate.js, which brings the Docker
// Compose stack up first and then shells out to `npx playwright test`.
//
// The phase-4 assertions all inspect one report view. A serial describe block
// runs a single beforeAll walk (idle -> listening -> emit phase-04 -> stop ->
// report) sharing one page, then each assertion runs as its own test in file
// order. One worker, no retries, no parallelism.

const { defineConfig, devices } = require('playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // The beforeAll walk drives real Weaver + collector lifecycle and raises its
  // own timeout; this is the per-test floor.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.PHASE4_BASE_URL || 'http://localhost:8080',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

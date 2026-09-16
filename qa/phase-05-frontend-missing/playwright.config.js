'use strict';

// Phase-05 Playwright config. Driven by validate.js, which brings the Docker
// Compose stack up first and then shells out to `npx playwright test`.
//
// The phase-5 assertions all inspect one report view's "what is missing?" tab.
// A serial describe block runs a single beforeAll walk (idle -> listening ->
// emit phase-05 -> stop -> report -> switch to the missing tab) sharing one
// page, then each assertion runs as its own test in file order. One worker, no
// retries, no parallelism.

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
    baseURL: process.env.PHASE5_BASE_URL || 'http://localhost:8080',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

'use strict';

// Phase-03 Playwright config. Driven by validate.js, which brings the Docker
// Compose stack up first and then shells out to `npx playwright test`.
//
// The phase-3 assertions form a single ordered walk through the session state
// machine (idle -> listening -> report), so the spec is a `describe.serial`
// block sharing one page. One worker, no retries, no parallelism.

const { defineConfig, devices } = require('playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // start/stop drive real Weaver + collector lifecycle; individual steps raise
  // their own timeout, this is the floor.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.PHASE3_BASE_URL || 'http://localhost:8080',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

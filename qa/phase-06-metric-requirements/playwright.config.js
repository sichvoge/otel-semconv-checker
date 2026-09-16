'use strict';

// Phase-06 Playwright config. Driven by validate.js Part B, which brings the
// Docker Compose stack up first and then shells out to `npx playwright test`.
//
// Assertion 10 inspects one report view's "what is missing?" tab. A serial
// describe block runs a single beforeAll walk (idle -> listening -> emit
// phase-05 -> stop -> report -> switch to the missing tab) sharing one page,
// then the single assertion runs as its own test. One worker, no retries.

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
    baseURL: process.env.PHASE6_BASE_URL || 'http://localhost:8080',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

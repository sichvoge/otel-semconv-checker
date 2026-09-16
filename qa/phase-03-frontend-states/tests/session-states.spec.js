'use strict';

/*
 * Phase-03 — frontend session states.
 *
 * One ordered walk through the UI state machine, sharing a single page:
 *
 *   idle  --[click start]-->  listening  --[click stop]-->  report
 *
 * Selectors mirror the prototype / builder implementation:
 *   #status-badge          header badge, classes status-idle|status-listening|status-complete
 *   #status-badge .pulse   pulsing dot on the listening badge (CSS `animation: pulse ...`)
 *   #main-btn              single start/stop button, classes btn-start|btn-stop
 *   .idle-pane .state-title  "ready to listen"
 *   #cnt-spans #cnt-metrics #cnt-logs #cnt-elapsed  live counters
 *   .rb / .rb .rbl         report resource banner ("resource")
 *
 * Live span counts (assertion 6) come from the backend scraping the collector's
 * internal-telemetry Prometheus endpoint, so this spec emits OTLP/HTTP traffic
 * with the shared test app once the session is listening.
 */

const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BASE = process.env.PHASE3_BASE_URL || 'http://localhost:8080';
const OTLP = process.env.PHASE3_OTLP_ENDPOINT || 'http://localhost:4318';
const TEST_APP = path.join(__dirname, '..', '..', 'test-app', 'index.js');

function emitTraffic() {
  try {
    execFileSync('node', [TEST_APP, '--scenario', 'phase-01', '--endpoint', OTLP], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    // Non-fatal: assertion 6 will surface a stalled counter on its own.
    console.log(`[spec] test-app emit failed: ${err && err.message}`);
  }
}

// A background is "green" when the green channel dominates and it is not a
// shade of grey. Covers both the light (#eaf3de) and dark (#173404) success
// tokens the button resolves `--color-background-success` to.
async function isGreenBg(locator) {
  return locator.evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return false;
    const [r, g, b] = m.map(Number);
    return g >= r && g > b && !(r === g && g === b);
  });
}

test.describe.serial('phase-3 frontend session states', () => {
  /** @type {import('playwright/test').Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#status-badge')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    if (page) await page.close();
  });

  test('1. page loads, idle state visible — "ready to listen" text present', async () => {
    await expect(page.locator('.idle-pane .state-title')).toHaveText(/ready to listen/i);
  });

  test('2. status badge reads "idle"', async () => {
    await expect(page.locator('#status-badge')).toHaveText(/^idle$/i);
    await expect(page.locator('#status-badge')).toHaveClass(/status-idle/);
  });

  test('3. start button visible and green (.btn-start)', async () => {
    const btn = page.locator('#main-btn.btn-start');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText(/start/i);
    expect(await isGreenBg(btn), 'btn-start background should be greenish').toBe(true);
  });

  test('4. click start -> button changes to "stop", status badge reads "listening"', async () => {
    test.setTimeout(180_000);
    await page.locator('#main-btn').click();
    // start blocks ~10-25s (weaver boot + collector restart)
    await expect(page.locator('#status-badge')).toHaveText(/listening/i, { timeout: 150_000 });
    await expect(page.locator('#status-badge')).toHaveClass(/status-listening/);
    await expect(page.locator('#main-btn.btn-stop')).toBeVisible();
    await expect(page.locator('#main-btn')).toHaveText(/stop/i);

    // Emit traffic so the live span counter can move (assertion 6).
    for (let i = 0; i < 3; i += 1) {
      emitTraffic();
      await page.waitForTimeout(1000);
    }
  });

  test('5. pulse animation visible on listening badge', async () => {
    const pulse = page.locator('#status-badge .pulse');
    await expect(pulse).toBeVisible();
    const animName = await pulse.evaluate((el) => getComputedStyle(el).animationName);
    expect(animName).toBe('pulse');
  });

  test('6. span counter increments within 5s of listening state', async () => {
    // Frontend polls GET /api/session every 2s; backend scrapes collector live.
    await expect(page.locator('#cnt-spans')).toHaveText(/^[1-9][0-9]*$/, { timeout: 15_000 });
  });

  test('7. elapsed timer increments', async () => {
    const read = async () => {
      const t = await page.locator('#cnt-elapsed').innerText();
      return parseInt(t.replace(/[^0-9]/g, ''), 10) || 0;
    };
    const before = await read();
    await page.waitForTimeout(2500);
    const after = await read();
    expect(after).toBeGreaterThan(before);
  });

  test('8. click stop -> status badge reads "report ready"', async () => {
    test.setTimeout(150_000);
    await page.locator('#main-btn').click();
    // stop blocks while weaver flushes the report
    await expect(page.locator('#status-badge')).toHaveText(/report ready/i, { timeout: 120_000 });
    await expect(page.locator('#status-badge')).toHaveClass(/status-complete/);
  });

  test('9. start button visible and green again after report', async () => {
    const btn = page.locator('#main-btn.btn-start');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText(/start/i);
    expect(await isGreenBg(btn), 'btn-start background should be greenish').toBe(true);
  });

  test('10. resource banner visible in report state', async () => {
    await expect(page.locator('.rb')).toBeVisible();
    await expect(page.locator('.rb .rbl')).toHaveText(/resource/i);
  });
});

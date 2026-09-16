'use strict';

/*
 * Phase-05 — frontend "what is missing?" tab.
 *
 * One ordered walk, sharing a single page:
 *
 *   idle --[click #main-btn]--> listening --[emit phase-05 OTLP]--> --[click stop]--> report
 *        --[click the "what is missing?" tab]--> missing tab
 *
 * The walk itself (start / emit / stop / report-ready / tab switch) is QA
 * infrastructure, not a phase assertion. It runs in beforeAll and writes
 * test-results/walk-status.json; validate.js reads that file and reports a walk
 * failure as assertion 99 ("not a phase failure") rather than failing the phase
 * assertions.
 *
 * The missing-tab contents are computed backend-side. beforeAll fetches
 * GET /api/report + GET /api/config and derives the expected view model the
 * same way the frontend transform does (report.missing[], minus custom-namespace
 * suppression) so the assertions check the rendered DOM against the backend
 * truth rather than against hard-coded values.
 *
 * Selectors mirror references/prototype-2026-04-15.html and the builder's
 * components:
 *   .pane-report                     report body container
 *   .stats .stat                     stat cards (nth(0) broken, nth(1) missing;
 *                                    .sval = number, .active-stat when its tab is active)
 *   .tab-bar .tab                    tabs; nth(1) = "what is missing?", .tab-count.tc-missing,
 *                                    .tab.active marks the active tab
 *   .filter-bar .pill                signal filter pills; .pill.sig-metric etc,
 *                                    text "metrics · N"; zero-count pill: class `zero`
 *   .ecard.missing                   never-emitted registry signal card
 *     .ehdr                          header (click to toggle)
 *     .badge.badge-metric            signal badge, text "metric"
 *     .ename                         metric name
 *     .stab (.stab-stable|.stab-dev) stability badge, text = stability
 *     .emeta                         "never emitted"
 *     .chev.open                     when expanded (missing cards default OPEN)
 *     .missing-body .attr-chips .attr-chip(.required|.recommended)  attribute chips
 */

const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.PHASE5_BASE_URL || 'http://localhost:8080';
const OTLP = process.env.PHASE5_OTLP_ENDPOINT || 'http://localhost:4318';
const TEST_APP = path.join(__dirname, '..', '..', 'test-app', 'index.js');
const WALK_STATUS = path.join(__dirname, '..', 'test-results', 'walk-status.json');

function writeWalk(obj) {
  fs.mkdirSync(path.dirname(WALK_STATUS), { recursive: true });
  fs.writeFileSync(WALK_STATUS, JSON.stringify(obj, null, 2));
}

function isCustomNamespace(name, prefixes) {
  if (!name || !Array.isArray(prefixes)) return false;
  return prefixes.some((p) => name === p || name.startsWith(`${p}.`));
}

// Mirror frontend lib/transform.js buildMissingModel: the backend already
// resolved each card; the frontend only re-applies custom-namespace suppression.
function buildExpectedMissing(report, config) {
  const missing = report && Array.isArray(report.missing) ? report.missing : [];
  const prefixes = (config && Array.isArray(config.custom_namespaces)) ? config.custom_namespaces : [];
  return missing
    .filter((m) => m && m.name && !isCustomNamespace(m.name, prefixes))
    .map((m) => ({
      name: m.name,
      signalType: m.signal_type || 'metric',
      stability: m.stability || 'development',
      attributes: Array.isArray(m.attributes)
        ? m.attributes.filter((a) => a && typeof a.name === 'string')
        : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Shared across the serial block, populated by beforeAll.
const ctx = {
  /** @type {any[]} */ expected: [],
  /** @type {string[]} */ names: [],
  rawMissingCount: 0,
};

test.describe.serial('phase-5 what-is-missing tab', () => {
  /** @type {import('playwright/test').Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(360_000);
    try {
      page = await browser.newPage();
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#status-badge')).toBeVisible({ timeout: 30_000 });

      // idle -> listening (start blocks on weaver boot + collector restart)
      await page.locator('#main-btn').click();
      await expect(page.locator('#status-badge')).toHaveText(/listening/i, { timeout: 200_000 });
      await expect(page.locator('#main-btn.btn-stop')).toBeVisible();

      // emit the phase-05 scenario (phase-04 superset + an http.request span)
      const out = execFileSync(
        'node',
        [TEST_APP, '--scenario', 'phase-05', '--endpoint', OTLP],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      console.log(`[spec] test-app phase-05 emit:\n${out}`);
      await page.waitForTimeout(3000);

      // listening -> report (stop blocks while weaver flushes the report)
      await page.locator('#main-btn').click();
      await expect(page.locator('#status-badge')).toHaveText(/report ready/i, { timeout: 150_000 });

      await expect(page.locator('.pane-report')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.ecard').first()).toBeVisible({ timeout: 30_000 });

      // pull the backend truth for the missing tab
      const repRes = await page.request.get(`${BASE}/api/report`);
      const cfgRes = await page.request.get(`${BASE}/api/config`);
      console.log(`[spec] GET /api/report -> HTTP ${repRes.status()}  GET /api/config -> HTTP ${cfgRes.status()}`);
      const report = await repRes.json();
      const config = await cfgRes.json();
      ctx.rawMissingCount = Array.isArray(report.missing) ? report.missing.length : -1;
      ctx.expected = buildExpectedMissing(report, config);
      ctx.names = ctx.expected.map((m) => m.name);
      console.log(`[spec] backend report.missing (${ctx.rawMissingCount}) -> expected cards after transform: ${JSON.stringify(ctx.expected, null, 2)}`);

      // switch to the "what is missing?" tab (second tab)
      const missingTab = page.locator('.tab-bar .tab').nth(1);
      await missingTab.click();
      await expect(missingTab).toHaveClass(/active/);
      await expect(page.locator('.ecard.missing').first()).toBeVisible({ timeout: 15_000 });

      writeWalk({ ok: true, rawMissingCount: ctx.rawMissingCount, expected: ctx.names });
    } catch (err) {
      writeWalk({ ok: false, error: String((err && err.stack) || err) });
      throw err;
    }
  });

  test.afterAll(async () => {
    if (page) await page.close();
  });

  async function resetFilter() {
    const all = page.locator('.filter-bar .pill', { hasText: /^all$/ });
    if (await all.count()) await all.first().click();
    await expect(page.locator('.filter-bar .pill').filter({ hasText: /^all$/ }).first())
      .toHaveClass(/active/);
  }

  function missingCard(name) {
    return page.locator('.ecard.missing').filter({
      has: page.locator('.ename', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }),
    });
  }

  test('1. Missing tab visible in tab bar', async () => {
    const tabs = page.locator('.tab-bar .tab');
    await expect(tabs).toHaveCount(2);
    const missingTab = tabs.nth(1);
    await expect(missingTab).toContainText(/what is missing\?/i);
    await expect(missingTab.locator('.tab-count.tc-missing')).toBeVisible();
    await expect(missingTab).toHaveClass(/active/);
  });

  test('2. Missing stat card shows correct count', async () => {
    await resetFilter();
    const missingStat = page.locator('.stats .stat').nth(1);
    await expect(missingStat).toHaveClass(/active-stat/);
    const shown = parseInt((await missingStat.locator('.sval').innerText()).replace(/[^0-9]/g, ''), 10);
    const renderedCards = await page.locator('.ecard.missing').count();
    // stat number == rendered missing cards == backend-computed report.missing (post custom-ns transform)
    expect(Number.isNaN(shown)).toBe(false);
    expect(shown).toBe(ctx.expected.length);
    expect(renderedCards).toBe(ctx.expected.length);
    // sanity: the two cards the plan expects are present
    expect(ctx.names).toEqual(expect.arrayContaining(['http.client.request.duration', 'http.server.active_requests']));
  });

  test('3. http.client.request.duration card visible in missing tab', async () => {
    await resetFilter();
    await expect(missingCard('http.client.request.duration')).toHaveCount(1);
    await expect(missingCard('http.client.request.duration')).toBeVisible();
  });

  test('4. http.client.request.duration shows a "stable" stability badge', async () => {
    const stab = missingCard('http.client.request.duration').locator('.stab');
    await expect(stab).toHaveText(/^stable$/);
    await expect(stab).toHaveClass(/stab-stable/);
  });

  test('5. http.request.method shown as a required chip (red) on that card', async () => {
    const card = missingCard('http.client.request.duration');
    // missing cards default OPEN, but be defensive
    if (!(await card.locator('.missing-body').isVisible().catch(() => false))) {
      await card.locator('.ehdr').click();
    }
    const chip = card.locator('.attr-chips .attr-chip', { hasText: /^http\.request\.method$/ });
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveClass(/\brequired\b/);
    // red: the danger token, not a grey
    const rgb = await chip.evaluate((el) => getComputedStyle(el).color);
    const m = rgb.match(/\d+(\.\d+)?/g).map(Number);
    expect(m[0]).toBeGreaterThan(m[2]); // red channel dominates blue
  });

  test('6. network.protocol.version shown as a recommended chip (amber) on that card', async () => {
    const card = missingCard('http.client.request.duration');
    if (!(await card.locator('.missing-body').isVisible().catch(() => false))) {
      await card.locator('.ehdr').click();
    }
    const chip = card.locator('.attr-chips .attr-chip', { hasText: /^network\.protocol\.version$/ });
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveClass(/\brecommended\b/);
    const rgb = await chip.evaluate((el) => getComputedStyle(el).color);
    const m = rgb.match(/\d+(\.\d+)?/g).map(Number);
    expect(m[0]).toBeGreaterThan(m[2]); // amber text: red channel dominates blue
  });

  test('7. ignored_metrics entry (http.client.request.body.size) does NOT appear in the missing tab', async () => {
    await resetFilter();
    expect(ctx.names).not.toContain('http.client.request.body.size');
    await expect(missingCard('http.client.request.body.size')).toHaveCount(0);
    const paneText = await page.locator('.pane-report').innerText();
    expect(paneText).not.toMatch(/http\.client\.request\.body\.size/);
  });

  test('8. expected_metrics entry (opt-in http.server.active_requests) DOES appear in the missing tab', async () => {
    await resetFilter();
    expect(ctx.names).toContain('http.server.active_requests');
    await expect(missingCard('http.server.active_requests')).toHaveCount(1);
    await expect(missingCard('http.server.active_requests')).toBeVisible();
  });

  test('9. http.server.request.duration does NOT appear in the missing tab (it was emitted)', async () => {
    await resetFilter();
    expect(ctx.names).not.toContain('http.server.request.duration');
    await expect(missingCard('http.server.request.duration')).toHaveCount(0);
  });

  test('10. signal filter — filtering by "metric" shows only metric cards', async () => {
    await resetFilter();
    const metricPill = page.locator('.filter-bar .pill.sig-metric');
    await expect(metricPill).toBeVisible();
    await expect(metricPill).toHaveText(/^metrics · \d+$/);

    const before = await page.locator('.ecard.missing').count();
    await metricPill.click();
    await expect(metricPill).toHaveClass(/active/);

    const badges = await page.locator('.ecard.missing .badge').allInnerTexts();
    expect(badges.length).toBeGreaterThanOrEqual(1);
    for (const b of badges) expect(b.trim()).toBe('metric');
    // every missing card is a metric, so the metric filter keeps them all
    expect(await page.locator('.ecard.missing').count()).toBe(before);

    // span / log pills carry a 0 count and are dimmed / non-interactive
    for (const s of ['span', 'log']) {
      const pill = page.locator(`.filter-bar .pill.sig-${s}`);
      if (await pill.count()) {
        await expect(pill).toHaveText(new RegExp(`^${s}s · 0$`));
        await expect(pill).toHaveClass(/zero/);
      }
    }
    await resetFilter();
  });
});

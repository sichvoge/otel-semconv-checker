'use strict';

/*
 * Phase-04 — frontend "what is broken?" tab.
 *
 * One ordered walk, sharing a single page:
 *
 *   idle --[click #main-btn]--> listening --[emit phase-04 OTLP]--> --[click stop]--> report
 *
 * The walk itself (start / emit / stop / report-ready) is QA infrastructure, not
 * a phase assertion. It runs in beforeAll and writes test-results/walk-status.json;
 * validate.js reads that file and reports a walk failure as assertion 99
 * ("not a phase failure") rather than failing the 11 phase assertions.
 *
 * Selectors mirror references/prototype-2026-04-15.html and the builder's
 * components:
 *   .pane-report                     report body container
 *   .stats .stat                     stat cards (first = broken; .sval = number; .active-stat when active)
 *   .tab-bar .tab                    tabs (first = "what is broken?", .active, .tab-count)
 *   .filter-bar .pill                signal filter pills; .pill.sig-span|sig-metric|sig-log
 *                                    text "spans · N" / "metrics · N" / "logs · N"
 *                                    zero-count pill: class `zero`, CSS opacity .35 / pointer-events none
 *   .ecard(.broken|.broken-imp)      entity cards; .ehdr header, .badge(.badge-span|badge-metric|badge-log),
 *                                    .ename signal name, .emeta, .chev(.open when expanded)
 *   .alist .aitem                    advice rows (visible only when card expanded):
 *                                    .adot (level class), .aid (finding id), .amsg (message), .acnt ("N×")
 */

const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.PHASE4_BASE_URL || 'http://localhost:8080';
const OTLP = process.env.PHASE4_OTLP_ENDPOINT || 'http://localhost:4318';
const TEST_APP = path.join(__dirname, '..', '..', 'test-app', 'index.js');
const WALK_STATUS = path.join(__dirname, '..', 'test-results', 'walk-status.json');

function writeWalk(obj) {
  fs.mkdirSync(path.dirname(WALK_STATUS), { recursive: true });
  fs.writeFileSync(WALK_STATUS, JSON.stringify(obj, null, 2));
}

test.describe.serial('phase-4 what-is-broken tab', () => {
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

      // emit the phase-04 scenario (richer span violations + phase-01 log/metric)
      const out = execFileSync(
        'node',
        [TEST_APP, '--scenario', 'phase-04', '--endpoint', OTLP],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      console.log(`[spec] test-app phase-04 emit:\n${out}`);
      await page.waitForTimeout(3000);

      // listening -> report (stop blocks while weaver flushes the report)
      await page.locator('#main-btn').click();
      await expect(page.locator('#status-badge')).toHaveText(/report ready/i, { timeout: 150_000 });

      // report body + at least one entity card must render
      await expect(page.locator('.pane-report')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.ecard').first()).toBeVisible({ timeout: 30_000 });

      // capture the parsed report the frontend transformed from
      try {
        const res = await page.request.get(`${BASE}/api/report`);
        console.log(`[spec] GET /api/report -> HTTP ${res.status()}`);
      } catch (e) {
        console.log(`[spec] GET /api/report failed: ${e && e.message}`);
      }

      writeWalk({ ok: true });
    } catch (err) {
      writeWalk({ ok: false, error: String((err && err.stack) || err) });
      throw err;
    }
  });

  test.afterAll(async () => {
    if (page) await page.close();
  });

  // Reset the signal filter to "all" so a prior test's filter click does not
  // leak into the next assertion.
  async function resetFilter() {
    const all = page.locator('.filter-bar .pill', { hasText: /^all$/ });
    if (await all.count()) await all.first().click();
    await expect(page.locator('.filter-bar .pill').filter({ hasText: /^all$/ }).first())
      .toHaveClass(/active/);
  }

  async function ensureOpen(card) {
    const chev = card.locator('.chev');
    const open = await chev.evaluate((el) => el.classList.contains('open')).catch(() => false);
    if (!open) await card.locator('.ehdr').click();
    await expect(card.locator('.alist')).toBeVisible();
  }

  test('1. Broken tab visible and active by default', async () => {
    await expect(page.locator('.pane-report')).toBeVisible();
    const firstTab = page.locator('.tab-bar .tab').first();
    await expect(firstTab).toContainText(/what is broken\?/i);
    await expect(firstTab).toHaveClass(/active/);
    // the broken tab body (filter bar + cards), not the "missing" placeholder
    await expect(page.locator('.filter-bar')).toBeVisible();
  });

  test('2. Broken stat card shows correct count', async () => {
    await resetFilter();
    const sval = page.locator('.stats .stat').first().locator('.sval');
    const shown = parseInt((await sval.innerText()).replace(/[^0-9]/g, ''), 10);
    const cardCount = await page.locator('.ecard').count();
    expect(Number.isNaN(shown)).toBe(false);
    expect(shown).toBe(cardCount);
    expect(shown).toBeGreaterThanOrEqual(3); // >=1 span group, >=1 metric group, >=1 log group
    // first stat card is the active one (its tab is active)
    await expect(page.locator('.stats .stat').first()).toHaveClass(/active-stat/);
  });

  test('3. Signal filter pills show spans/metrics/logs with counts', async () => {
    const span = page.locator('.filter-bar .pill.sig-span');
    const metric = page.locator('.filter-bar .pill.sig-metric');
    const log = page.locator('.filter-bar .pill.sig-log');
    await expect(span).toBeVisible();
    await expect(metric).toBeVisible();
    await expect(log).toBeVisible();
    await expect(span).toHaveText(/^spans · \d+$/);
    await expect(metric).toHaveText(/^metrics · \d+$/);
    await expect(log).toHaveText(/^logs · \d+$/);

    const num = async (loc) => parseInt((await loc.innerText()).replace(/^\D+/, ''), 10);
    const s = await num(span);
    const m = await num(metric);
    const l = await num(log);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(m).toBeGreaterThanOrEqual(1);
    expect(l).toBeGreaterThanOrEqual(1);
    // pill counts partition the visible cards
    expect(s + m + l).toBe(await page.locator('.ecard').count());
  });

  test('4. my-service span card visible in broken tab', async () => {
    await resetFilter();
    const card = page.locator('.ecard', {
      has: page.locator('.badge.badge-span'),
    }).filter({ has: page.locator('.ename', { hasText: /^my-service$/ }) });
    await expect(card.first()).toBeVisible();
  });

  test('5. deprecated finding for http.method visible when card expanded', async () => {
    const card = page.locator('.ecard').filter({
      has: page.locator('.ename', { hasText: /^my-service$/ }),
    }).first();
    await ensureOpen(card);
    const item = card.locator('.alist .aitem').filter({
      has: page.locator('.aid', { hasText: /^deprecated$/ }),
    }).filter({ hasText: /http\.method/ });
    await expect(item.first()).toBeVisible();
    await expect(item.first().locator('.adot')).toHaveClass(/violation/);
  });

  test('6. deprecated finding for http.url visible when card expanded', async () => {
    const card = page.locator('.ecard').filter({
      has: page.locator('.ename', { hasText: /^my-service$/ }),
    }).first();
    await ensureOpen(card);
    const item = card.locator('.alist .aitem').filter({
      has: page.locator('.aid', { hasText: /^deprecated$/ }),
    }).filter({ hasText: /http\.url/ });
    await expect(item.first()).toBeVisible();
    await expect(item.first().locator('.adot')).toHaveClass(/violation/);
  });

  test('7. required_attribute_not_present for http.request.method on http.server.request.duration metric card', async () => {
    const card = page.locator('.ecard').filter({
      has: page.locator('.ename', { hasText: /^http\.server\.request\.duration$/ }),
    }).first();
    await expect(card).toBeVisible();
    await expect(card.locator('.badge')).toHaveClass(/badge-metric/);
    await ensureOpen(card);
    const item = card.locator('.alist .aitem').filter({
      has: page.locator('.aid', { hasText: /^required_attribute_not_present$/ }),
    }).filter({ hasText: /http\.request\.method/ });
    await expect(item.first()).toBeVisible();
    await expect(item.first().locator('.adot')).toHaveClass(/violation/);
  });

  test('8. custom.* signals do not appear anywhere in broken tab', async () => {
    await resetFilter();
    const enames = await page.locator('.ecard .ename').allInnerTexts();
    for (const n of enames) expect(n.startsWith('custom.')).toBe(false);
    const paneText = await page.locator('.pane-report').innerText();
    expect(paneText).not.toMatch(/custom\.request\.count/);
    expect(paneText).not.toMatch(/custom\.user_id/);
    // expand every card so any nested custom finding would be in the DOM text
    const cards = page.locator('.ecard');
    const total = await cards.count();
    for (let i = 0; i < total; i += 1) await ensureOpen(cards.nth(i));
    const expandedText = await page.locator('.pane-report').innerText();
    expect(expandedText).not.toMatch(/\bcustom\./);
  });

  test('9. filtering by "spans" shows only span cards', async () => {
    await page.locator('.filter-bar .pill.sig-span').click();
    await expect(page.locator('.filter-bar .pill.sig-span')).toHaveClass(/active/);
    const badges = await page.locator('.ecard .badge').evaluateAll(
      (els) => els.map((e) => e.className),
    );
    expect(badges.length).toBeGreaterThanOrEqual(1);
    for (const c of badges) {
      expect(c).toMatch(/badge-span/);
      expect(c).not.toMatch(/badge-metric|badge-log/);
    }
    await resetFilter();
  });

  test('10. zero-count metric pill is dimmed and non-clickable', async () => {
    const zero = page.locator('.filter-bar .pill.zero');
    const count = await zero.count();
    if (count === 0) {
      test.info().annotations.push({
        type: 'note',
        description: 'no zero-count pill under the phase-04 scenario (see plan note): spans + metrics + logs each have >=1 broken group, so assertion 7 (metric card present) and a literal zero metric pill cannot both hold. Passing vacuously per QA task instructions.',
      });
      console.log('[spec] assertion 10: no zero-count pill present under phase-04 — passing per plan note.');
      return;
    }
    const first = zero.first();
    const css = await first.evaluate((el) => {
      const s = getComputedStyle(el);
      return { pe: s.pointerEvents, op: parseFloat(s.opacity) };
    });
    expect(css.pe).toBe('none');
    expect(css.op).toBeLessThan(0.6);
    // non-clickable: force a click and confirm it does not become active / change filter
    const activeBefore = await page.locator('.filter-bar .pill.active').innerText();
    await first.click({ force: true }).catch(() => {});
    await expect(first).not.toHaveClass(/active/);
    const activeAfter = await page.locator('.filter-bar .pill.active').innerText();
    expect(activeAfter).toBe(activeBefore);
  });

  test('11. cards with violations expanded by default', async () => {
    // fresh reload so no manual toggles from earlier tests are in play
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.pane-report')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ecard').first()).toBeVisible({ timeout: 30_000 });

    const broken = page.locator('.ecard.broken');
    const n = await broken.count();
    expect(n).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < n; i += 1) {
      const c = broken.nth(i);
      await expect(c.locator('.chev')).toHaveClass(/open/);
      await expect(c.locator('.alist')).toBeVisible();
    }
    // improvement-only cards (if any) default collapsed
    const imp = page.locator('.ecard.broken-imp');
    const m = await imp.count();
    for (let i = 0; i < m; i += 1) {
      await expect(imp.nth(i).locator('.chev')).not.toHaveClass(/open/);
    }
  });
});

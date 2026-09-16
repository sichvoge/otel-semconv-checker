#!/usr/bin/env node
/*
 * Phase-06 — metric requirements script + missing-tab requirement level.
 * Fully autonomous. Run:  node validate.js   (from this folder)
 *
 * Part A — no stack:
 *   1.  Run scripts/fetch-metric-requirements.js with --out <here>/actual.json
 *       (so the committed backend/src/data/metric-requirements.json is NEVER
 *       clobbered). Capture stderr for the summary line check.
 *   2.  Assert exit 0 (assertion 1). If the run fails ONLY because the QA
 *       machine cannot reach api.github.com / raw.githubusercontent.com, that
 *       is reported as an environment limitation, not an implementation defect.
 *   3.  Load actual.json and validate assertions 1-9 against
 *       expected/known-metrics.json.
 *
 * Part B — stack (assertion 10):
 *   4.  COMPOSE_PROFILES=app docker compose -f docker-compose.test.yml up -d --build
 *       (UID/GID exported; the `app` profile pulls in backend + frontend)
 *   5.  Poll GET http://localhost:3001/api/health (budget 120s cold) and
 *       GET http://localhost:8080/ (budget 60s).
 *   6.  npx playwright test — tests/missing-level.spec.js drives one ordered
 *       walk (idle -> listening -> emit phase-05 -> stop -> report -> missing
 *       tab) and asserts the .mlevel pill on the http.client.request.duration
 *       card reads "recommended", cross-checked against GET /api/report
 *       report.missing[].requirement_level.
 *   7.  COMPOSE_PROFILES=app docker compose ... down -v --remove-orphans  (finally)
 *
 * Only reads/writes under qa/. Never mutates implementation files.
 *
 * validate.js / Playwright / the session walk failing to run at all is reported
 * as assertion 99 — a QA-infrastructure failure, NOT a phase failure.
 * Exits 0 (all 10 pass) / 1 (any fail or infra error).
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRAPER = path.join(REPO_ROOT, 'backend', 'scripts', 'fetch-metric-requirements.js');
const ACTUAL = path.join(HERE, 'actual.json');
const KNOWN = path.join(HERE, 'expected', 'known-metrics.json');
const COMPOSE_FILE = path.join(HERE, 'docker-compose.test.yml');
const RESULTS_JSON = path.join(HERE, 'test-results', 'results.json');
const WALK_STATUS = path.join(HERE, 'test-results', 'walk-status.json');
const API = 'http://localhost:3001';
const FRONTEND = 'http://localhost:8080';

const EXPECTED_ASSERTIONS = 10;
const VALID_LEVELS = new Set(['required', 'recommended', 'opt_in']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const log = (m) => console.log(`[QA] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
const composeEnv = {
  ...process.env,
  UID: String(uid),
  GID: String(gid),
  COMPOSE_PROFILES: 'app',
};

function compose(args, opts = {}) {
  return spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    cwd: HERE,
    env: composeEnv,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    ...opts,
  });
}

async function pollHttp200(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) return true;
    } catch (_) { /* not up yet */ }
    await sleep(2000);
  }
  log(`  ${label} never returned 200 within ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

async function gitHubReachable() {
  for (const url of [
    'https://api.github.com/rate_limit',
    'https://raw.githubusercontent.com/open-telemetry/semantic-conventions/main/README.md',
  ]) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'otel-semconv-checker-qa' }, signal: AbortSignal.timeout(8000) });
      if (res.ok) return true;
    } catch (_) { /* keep trying */ }
  }
  return false;
}

function collectSpecs(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node.specs)) {
    for (const spec of node.specs) {
      const status = Array.isArray(spec.tests)
        ? spec.tests.every((t) => t.status === 'expected' || t.status === 'flaky')
        : false;
      acc.push({ title: spec.title, ok: spec.ok === true && status });
    }
  }
  if (Array.isArray(node.suites)) for (const s of node.suites) collectSpecs(s, acc);
  return acc;
}

// ---------------------------------------------------------------------------
const results = [];
const assert = (n, desc, pass, detail) => {
  results.push({ n, desc, pass: !!pass, detail: detail || '' });
};

// ---------------------------------------------------------------------------
// Part A — run the scraper and validate its JSON output (assertions 1-9).
// ---------------------------------------------------------------------------
async function partA() {
  log('Part A — fetch-metric-requirements.js + JSON assertions (no stack)');
  fs.rmSync(ACTUAL, { force: true });

  log(`Running: node ${path.relative(REPO_ROOT, SCRAPER)} --out ${path.relative(REPO_ROOT, ACTUAL)}`);
  const run = spawnSync('node', [SCRAPER, '--out', ACTUAL], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const stderr = run.stderr || '';
  const stdout = run.stdout || '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  log(`Scraper exited ${run.status}.`);

  // -- assertion 1 --
  if (run.status === 0) {
    assert(1, 'node scripts/fetch-metric-requirements.js exits 0', true);
  } else {
    const online = await gitHubReachable();
    if (!online) {
      assert(1, 'node scripts/fetch-metric-requirements.js exits 0', false,
        'ENVIRONMENT LIMITATION — QA machine has no outbound network to api.github.com / raw.githubusercontent.com; not an implementation defect');
    } else {
      assert(1, 'node scripts/fetch-metric-requirements.js exits 0', false,
        `exit ${run.status} despite GitHub being reachable — see scraper stderr above`);
    }
  }

  // -- assertion 2 --
  let doc = null;
  let jsonOk = false;
  if (fs.existsSync(ACTUAL)) {
    try {
      doc = JSON.parse(fs.readFileSync(ACTUAL, 'utf8'));
      jsonOk = doc && typeof doc === 'object' && !Array.isArray(doc);
    } catch (e) {
      assert(2, 'metric-requirements.json exists and is valid JSON', false, `parse error: ${e.message}`);
    }
    if (doc !== null && jsonOk) assert(2, 'metric-requirements.json exists and is valid JSON', true, `${path.relative(HERE, ACTUAL)}`);
    else if (doc !== null && !jsonOk) assert(2, 'metric-requirements.json exists and is valid JSON', false, 'parsed value is not a JSON object');
  } else {
    assert(2, 'metric-requirements.json exists and is valid JSON', false, `${path.relative(HERE, ACTUAL)} not produced`);
  }

  const metrics = doc && doc.metrics && typeof doc.metrics === 'object' ? doc.metrics : null;

  // -- assertion 3 --
  if (doc) {
    const g = doc.generated_at;
    const isoOk = typeof g === 'string' && ISO_RE.test(g) && !Number.isNaN(Date.parse(g));
    assert(3, 'generated_at is a valid ISO timestamp', isoOk, isoOk ? String(g) : `got ${JSON.stringify(g)}`);
  } else {
    assert(3, 'generated_at is a valid ISO timestamp', false, 'no document');
  }

  // -- assertion 4 --
  const metricCount = metrics ? Object.keys(metrics).length : 0;
  assert(4, 'metrics object is non-empty', metricCount > 0, `${metricCount} metrics`);

  // -- assertions 5-7 (driven by expected/known-metrics.json) --
  let known = {};
  try {
    known = JSON.parse(fs.readFileSync(KNOWN, 'utf8'));
  } catch (e) {
    assert(97, 'expected/known-metrics.json loads', false, e.message);
  }
  const knownEntries = Object.entries(known);
  const numbering = { 'http.server.request.duration': 5, 'http.client.request.duration': 6, 'http.server.active_requests': 7 };
  let extraKnownFailures = [];
  knownEntries.forEach(([name, want], idx) => {
    const got = metrics ? metrics[name] : undefined;
    const pass = got === want;
    const n = numbering[name];
    if (n) {
      assert(n, `${name} -> "${want}"`, pass, pass ? '' : `got ${JSON.stringify(got)}`);
    } else if (!pass) {
      extraKnownFailures.push(`${name}: want ${want}, got ${JSON.stringify(got)}`);
    }
  });
  // guard: make sure the three numbered assertions were actually emitted
  for (const [name, n] of Object.entries(numbering)) {
    if (!results.some((r) => r.n === n)) {
      assert(n, `${name} known requirement level`, false, 'not present in expected/known-metrics.json');
    }
  }

  // -- assertion 8 --
  if (metrics) {
    const bad = [];
    for (const [name, val] of Object.entries(metrics)) {
      if (typeof val !== 'string' || !VALID_LEVELS.has(val)) bad.push(`${name}=${JSON.stringify(val)}`);
    }
    const detail = bad.length
      ? `${bad.length} out-of-enum: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' …' : ''}`
      : `all ${metricCount} values in {required, recommended, opt_in}${extraKnownFailures.length ? ` (note: extra known-metric mismatch: ${extraKnownFailures.join('; ')})` : ''}`;
    assert(8, 'no metric value outside "required" / "recommended" / "opt_in"', bad.length === 0 && extraKnownFailures.length === 0, detail);
  } else {
    assert(8, 'no metric value outside "required" / "recommended" / "opt_in"', false, 'no metrics object');
  }

  // -- assertion 9 --
  const pagesLine = /pages fetched:\s*\d+\/\d+/i.test(stderr);
  const metricsLine = /metrics found:\s*\d+/i.test(stderr);
  const pfMatch = stderr.match(/pages fetched:\s*[^\n]+/i);
  const mfMatch = stderr.match(/metrics found:\s*[^\n]+/i);
  assert(9, 'script summary lists pages fetched and metrics found', pagesLine && metricsLine,
    `${pfMatch ? pfMatch[0].trim() : 'no "pages fetched" line'} | ${mfMatch ? mfMatch[0].trim() : 'no "metrics found" line'}`);

  // informational: by-level breakdown
  if (metrics) {
    const byLevel = Object.values(metrics).reduce((a, v) => { a[v] = (a[v] || 0) + 1; return a; }, {});
    log(`  scraped ${metricCount} metrics; by level: ${JSON.stringify(byLevel)}`);
  }
}

// ---------------------------------------------------------------------------
// Part B — stack + Playwright (assertion 10).
// ---------------------------------------------------------------------------
async function partB() {
  log('Part B — stack + missing-tab requirement-level chip (assertion 10)');
  let stackUp = false;
  let infraFailure = null;

  try {
    try {
      require.resolve('playwright/test');
    } catch (_) {
      log('Installing QA dependencies (npm install --offline) ...');
      let ni = spawnSync('npm', ['install', '--offline', '--no-audit', '--no-fund'], {
        cwd: HERE, encoding: 'utf8', stdio: 'inherit',
      });
      if (ni.status !== 0) {
        log('offline install failed, retrying online ...');
        ni = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
          cwd: HERE, encoding: 'utf8', stdio: 'inherit',
        });
      }
      if (ni.status !== 0) throw new Error(`npm install exited ${ni.status}`);
    }

    log('COMPOSE_PROFILES=app docker compose up -d --build ...');
    compose(['down', '-v', '--remove-orphans'], { stdio: 'pipe' });
    const up = compose(['up', '-d', '--build'], { inherit: true });
    stackUp = true;
    if (up.status !== 0) throw new Error(`compose up exited ${up.status}`);
    log('Stack started.');

    log('Polling GET /api/health (budget 120s) ...');
    const healthy = await pollHttp200(`${API}/api/health`, 120000, 'backend /api/health');
    if (!healthy) throw new Error('backend /api/health never returned 200 — cannot continue');
    log('Backend healthy.');

    log('Polling GET http://localhost:8080/ (budget 60s) ...');
    const feOk = await pollHttp200(`${FRONTEND}/`, 60000, 'frontend http://localhost:8080/');
    if (!feOk) throw new Error('frontend http://localhost:8080/ never returned 200 — cannot continue');
    log('Frontend reachable.');

    log('Running Playwright: npx playwright test (chromium) ...');
    const pw = spawnSync('npx', ['playwright', 'test'], {
      cwd: HERE,
      env: {
        ...process.env,
        PHASE6_BASE_URL: FRONTEND,
        PHASE6_OTLP_ENDPOINT: 'http://localhost:4318',
        PLAYWRIGHT_JSON_OUTPUT_NAME: path.relative(HERE, RESULTS_JSON),
      },
      encoding: 'utf8',
      stdio: 'inherit',
    });
    log(`Playwright exited ${pw.status}.`);

    // the walk (start/emit/stop/report-ready/tab switch) is infra, not a phase assertion
    let walk = null;
    if (fs.existsSync(WALK_STATUS)) {
      try {
        walk = JSON.parse(fs.readFileSync(WALK_STATUS, 'utf8'));
      } catch (e) {
        walk = { ok: false, error: `walk-status.json unparseable: ${e.message}` };
      }
    }
    if (!walk || walk.ok !== true) {
      infraFailure = `session walk did not reach the missing tab: ${
        walk && walk.error ? String(walk.error).split('\n')[0] : 'walk-status.json missing'
      }`;
      throw new Error(infraFailure);
    }
    log(`Session walk reached the missing tab (idle -> listening -> report -> missing).`);
    log(`  backend report.missing count=${walk.rawMissingCount}; http.client.request.duration API level=${JSON.stringify(walk.apiLevel)}`);

    if (!fs.existsSync(RESULTS_JSON)) {
      infraFailure = `Playwright produced no results file (${path.relative(HERE, RESULTS_JSON)}); exit=${pw.status}`;
      throw new Error(infraFailure);
    }
    let report;
    try {
      report = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'));
    } catch (e) {
      infraFailure = `results.json is not valid JSON: ${e.message}`;
      throw new Error(infraFailure);
    }

    const specs = collectSpecs(report, []);
    if (specs.length === 0) {
      infraFailure = 'results.json contained no specs — Playwright did not run any test';
      throw new Error(infraFailure);
    }
    specs.forEach((s) => {
      const n = parseInt(s.title, 10);
      assert(Number.isNaN(n) ? 10 : n, s.title.replace(/^\d+\.\s*/, ''), s.ok);
    });
  } catch (err) {
    log(`ERROR during Part B: ${err && err.stack ? err.stack : err}`);
    if (infraFailure) {
      assert(99, `QA-infra failure: ${infraFailure}`, false, 'Playwright / session walk could not run — not a phase failure');
    } else if (!results.some((r) => r.n === 10)) {
      assert(99, `Part B aborted: ${err && err.message ? err.message : err}`, false, 'see log above');
    }
  } finally {
    if (stackUp) {
      log('Tearing down stack (COMPOSE_PROFILES=app down -v --remove-orphans) ...');
      compose(['down', '-v', '--remove-orphans'], { inherit: true });
    }
  }
}

// ---------------------------------------------------------------------------
async function main() {
  try {
    await partA();
  } catch (err) {
    log(`ERROR during Part A: ${err && err.stack ? err.stack : err}`);
    if (results.length === 0) {
      assert(99, `Part A aborted: ${err && err.message ? err.message : err}`, false, 'validate.js could not run the scraper — not a phase failure');
    }
  }

  await partB();

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('');
  log('Assertion results:');
  for (const r of results.slice().sort((a, b) => a.n - b.n)) {
    log(`  ${r.pass ? '✓' : '✗'} ${r.n}. ${r.desc}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('');
  const phaseAssertions = results.filter((r) => r.n >= 1 && r.n <= EXPECTED_ASSERTIONS);
  if (passed === total && phaseAssertions.length >= EXPECTED_ASSERTIONS && phaseAssertions.every((r) => r.pass)) {
    log(`PASSED — ${passed}/${total} assertions passed`);
    process.exit(0);
  } else {
    log(`FAILED — ${passed}/${total} assertions passed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[QA] validate.js crashed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

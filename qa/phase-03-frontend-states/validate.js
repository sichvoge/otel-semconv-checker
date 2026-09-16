#!/usr/bin/env node
/*
 * Phase-03 frontend session-state validation. Fully autonomous.
 *
 *   1.  COMPOSE_PROFILES=app docker compose -f docker-compose.test.yml up -d --build
 *       (UID/GID exported; the `app` profile pulls in backend + frontend)
 *   2.  Poll GET http://localhost:3001/api/health until 200 (budget 120s cold —
 *       image builds + npm ci + weaver healthcheck gating the backend)
 *   3.  Poll GET http://localhost:8080/ (frontend / nginx) until 200 (budget 60s)
 *   4.  Run `npx playwright test` (chromium) — tests/session-states.spec.js drives
 *       the phase-3 assertions as one ordered walk through idle -> listening ->
 *       report, emitting OTLP/HTTP traffic via ../test-app/index.js while
 *       listening so the live span counter can move.
 *   5.  Parse test-results/results.json into a per-assertion summary
 *   6.  COMPOSE_PROFILES=app docker compose ... down -v --remove-orphans
 *   7.  Print summary, exit 0 (all 10 pass) / 1 (any fail or infra error)
 *
 * Only reads/writes under qa/. Never mutates implementation files.
 *
 * A failure to even run Playwright (missing browser, config error, no results
 * file) is reported as a QA-infrastructure failure, distinct from a phase
 * assertion failure.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const COMPOSE_FILE = path.join(HERE, 'docker-compose.test.yml');
const RESULTS_JSON = path.join(HERE, 'test-results', 'results.json');
const API = 'http://localhost:3001';
const FRONTEND = 'http://localhost:8080';

const EXPECTED_ASSERTIONS = 10;

const log = (m) => console.log(`[QA] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UID/GID for the weaver container's `user:` and bind-mount write permissions,
// plus COMPOSE_PROFILES=app so backend + frontend services are included.
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
    } catch (_) {
      /* not up yet */
    }
    await sleep(2000);
  }
  log(`  ${label} never returned 200 within ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

// ---- results parsing ----------------------------------------------------

// Flatten Playwright JSON reporter output into { title, ok } rows in file order.
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

async function main() {
  let stackUp = false;
  let infraFailure = null;

  try {
    fs.rmSync(path.join(HERE, 'test-results'), { recursive: true, force: true });

    // -- 0. ensure Playwright is installed (browsers are pre-cached) --------
    try {
      require.resolve('playwright/test');
    } catch (_) {
      log('Installing QA dependencies (npm install) ...');
      const ni = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: HERE, encoding: 'utf8', stdio: 'inherit',
      });
      if (ni.status !== 0) throw new Error(`npm install exited ${ni.status}`);
    }

    // -- 1. bring the stack up (app profile: + backend + frontend) -----------
    log('COMPOSE_PROFILES=app docker compose up -d --build ...');
    compose(['down', '-v', '--remove-orphans'], { stdio: 'pipe' });
    const up = compose(['up', '-d', '--build'], { inherit: true });
    stackUp = true;
    if (up.status !== 0) throw new Error(`compose up exited ${up.status}`);
    log('Stack started.');

    // -- 2. backend health (cold-machine budget) ---------------------------
    log('Polling GET /api/health (budget 120s) ...');
    const healthy = await pollHttp200(`${API}/api/health`, 120000, 'backend /api/health');
    if (!healthy) throw new Error('backend /api/health never returned 200 — cannot continue');
    log('Backend healthy.');

    // -- 3. frontend (nginx) reachable -----------------------------------
    log('Polling GET http://localhost:8080/ (budget 60s) ...');
    const feOk = await pollHttp200(`${FRONTEND}/`, 60000, 'frontend http://localhost:8080/');
    if (!feOk) throw new Error('frontend http://localhost:8080/ never returned 200 — cannot continue');
    log('Frontend reachable.');

    // -- 4. run Playwright ------------------------------------------------
    log('Running Playwright: npx playwright test (chromium) ...');
    const pw = spawnSync('npx', ['playwright', 'test'], {
      cwd: HERE,
      env: {
        ...process.env,
        PHASE3_BASE_URL: FRONTEND,
        PHASE3_OTLP_ENDPOINT: 'http://localhost:4318',
        PLAYWRIGHT_JSON_OUTPUT_NAME: path.relative(HERE, RESULTS_JSON),
      },
      encoding: 'utf8',
      stdio: 'inherit',
    });
    log(`Playwright exited ${pw.status}.`);

    // -- 5. parse results ----------------------------------------------
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

    specs.sort((a, b) => {
      const na = parseInt(a.title, 10);
      const nb = parseInt(b.title, 10);
      return (Number.isNaN(na) ? 999 : na) - (Number.isNaN(nb) ? 999 : nb);
    });

    specs.forEach((s, i) => {
      const n = parseInt(s.title, 10);
      assert(Number.isNaN(n) ? i + 1 : n, s.title.replace(/^\d+\.\s*/, ''), s.ok);
    });

    if (specs.length !== EXPECTED_ASSERTIONS) {
      assert(98, `expected ${EXPECTED_ASSERTIONS} assertions, ran ${specs.length}`, false, 'spec count mismatch');
    }
  } catch (err) {
    log(`ERROR during run: ${err && err.stack ? err.stack : err}`);
    if (infraFailure) {
      assert(99, `QA-infra failure: ${infraFailure}`, false, 'validate.js / Playwright could not run — not a phase failure');
    } else if (results.length === 0) {
      assert(99, `validate.js run aborted: ${err && err.message ? err.message : err}`, false, 'see log above');
    }
  } finally {
    // -- 6. tear down --------------------------------------------------
    if (stackUp) {
      log('Tearing down stack (COMPOSE_PROFILES=app down -v --remove-orphans) ...');
      compose(['down', '-v', '--remove-orphans'], { inherit: true });
    }
  }

  // -- 7. summary -----------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('');
  log('Assertion results:');
  for (const r of results) {
    log(`  ${r.pass ? '✓' : '✗'} ${r.n}. ${r.desc}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('');
  if (passed === total && total >= EXPECTED_ASSERTIONS) {
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

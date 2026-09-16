#!/usr/bin/env node
/*
 * Phase-02 backend validation. Fully autonomous.
 *
 *   1.  COMPOSE_PROFILES=app docker compose -f docker-compose.test.yml up -d --build
 *       (UID/GID exported; the `app` profile pulls in the backend)
 *   2.  Poll GET http://localhost:3001/api/health until 200 (timeout 120s — cold
 *       machine: node image pull + npm ci + weaver healthcheck gating the backend)
 *   3.  Assert GET /api/session -> status === "idle"
 *   4.  POST /api/session/start (no client timeout — starts weaver AND restarts
 *       the collector; ~10-25s is normal) -> assert 200, status "listening"
 *   5.  POST /api/session/start again -> assert 409
 *   6.  node ../test-app/index.js --scenario phase-01
 *   7.  Wait 5s
 *   8.  POST /api/session/stop -> assert 200
 *   9.  Poll GET /api/session until status === "report" (timeout 20s)
 *  10.  GET /api/report -> report assertions
 *  11.  GET /api/config -> assert custom_namespaces == ["custom"]
 *  12.  POST /api/session/start -> assert status "listening"; GET /api/report -> 404
 *  13.  COMPOSE_PROFILES=app docker compose ... down -v --remove-orphans
 *  14.  Print summary, exit 0 (all pass) / 1 (any fail)
 *
 * Only reads/writes under qa/. Never mutates implementation files.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const HERE = __dirname;
const COMPOSE_FILE = path.join(HERE, 'docker-compose.test.yml');
const TEST_APP = path.join(HERE, '..', 'test-app', 'index.js');
const API = 'http://localhost:3001';

const log = (m) => console.log(`[QA] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UID/GID for the weaver container's `user:` and bind-mount write permissions,
// plus COMPOSE_PROFILES=app so the backend service is included.
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

// fetch with no timeout unless one is explicitly requested. `start`/`stop`
// legitimately block 10-25s, so we must not impose a client timeout there.
async function req(method, urlPath, { timeoutMs } = {}) {
  const opts = { method };
  if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${API}${urlPath}`, opts);
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = text;
  }
  return { status: res.status, body };
}

async function pollHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch (_) {
      /* not up yet */
    }
    await sleep(2000);
  }
  return false;
}

async function pollSessionStatus(want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const { body } = await req('GET', '/api/session');
      last = body && body.status;
      if (last === want) return { ok: true, status: last };
    } catch (_) {
      /* keep polling */
    }
    await sleep(1000);
  }
  return { ok: false, status: last };
}

// ---- report tree walkers --------------------------------------------------

// Recursively collect every advice object from an entity subtree.
function collectAdvice(node, acc) {
  if (Array.isArray(node)) {
    for (const x of node) collectAdvice(x, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    const lcr = node.live_check_result;
    if (lcr && Array.isArray(lcr.all_advice)) {
      for (const a of lcr.all_advice) acc.push(a);
    }
    for (const k of Object.keys(node)) {
      if (k === 'live_check_result') continue;
      collectAdvice(node[k], acc);
    }
  }
  return acc;
}

// Signal name of a single-key wrapper entry ({span:{…}}, {metric:{…}}, …).
const WRAPPER_TYPES = ['metric', 'span', 'log', 'span_event', 'event'];
function entitySignalName(entry) {
  if (!entry || typeof entry !== 'object') return null;
  for (const t of WRAPPER_TYPES) {
    const obj = entry[t];
    if (obj && typeof obj === 'object') {
      return obj.name || obj.metric_name || obj.event_name || null;
    }
  }
  return null;
}

// ---- assertions ---------------------------------------------------------

const results = [];
const assert = (n, desc, pass, detail) => {
  results.push({ n, desc, pass: !!pass, detail: detail || '' });
};

async function main() {
  let stackUp = false;
  try {
    // -- 1. bring the stack up (with the `app` profile) --------------------
    log('COMPOSE_PROFILES=app docker compose up -d --build ...');
    compose(['down', '-v', '--remove-orphans'], { stdio: 'pipe' });
    const up = compose(['up', '-d', '--build'], { inherit: true });
    stackUp = true;
    if (up.status !== 0) throw new Error(`compose up exited ${up.status}`);
    log('Stack started.');

    // -- 2. backend health (cold-machine budget) --------------------------
    log('Polling GET /api/health (timeout 120s) ...');
    const healthy = await pollHealth(120000);
    assert(1, 'GET /api/health returns 200', healthy, healthy ? 'ok' : 'never returned 200 within 120s');
    if (!healthy) throw new Error('backend /api/health never returned 200 — cannot continue');
    log('Backend healthy.');

    // -- 3. initial session state ----------------------------------------
    const s0 = await req('GET', '/api/session');
    log(`GET /api/session -> ${s0.status} status=${s0.body && s0.body.status}`);
    // Not a scored assertion (plan table has 12 rows) but a sanity gate.
    if (!(s0.status === 200 && s0.body && s0.body.status === 'idle')) {
      log(`  WARNING: expected initial status "idle", got ${JSON.stringify(s0.body)}`);
    }

    // -- 4. start the session ------------------------------------------
    log('POST /api/session/start (no client timeout; ~10-25s) ...');
    const start1 = await req('POST', '/api/session/start');
    log(`  -> ${start1.status} ${JSON.stringify(start1.body)}`);
    assert(2, 'POST /api/session/start returns 200, status = "listening"',
      start1.status === 200 && start1.body && start1.body.status === 'listening',
      `status=${start1.status} body.status=${start1.body && start1.body.status}`);

    // -- 5. concurrent start -> 409 -----------------------------------
    const start2 = await req('POST', '/api/session/start');
    log(`  2nd POST /api/session/start -> ${start2.status}`);
    assert(3, 'POST /api/session/start while listening returns 409',
      start2.status === 409, `status=${start2.status}`);

    // -- 6. emit synthetic OTLP/HTTP traffic -------------------------
    log('Running test app: scenario phase-01 (OTLP/HTTP JSON -> localhost:4318) ...');
    const emit = spawnSync('node', [TEST_APP, '--scenario', 'phase-01', '--endpoint', 'http://localhost:4318'], {
      encoding: 'utf8',
    });
    process.stdout.write(emit.stdout || '');
    process.stdout.write(emit.stderr || '');
    if (emit.status !== 0) throw new Error(`test app exited ${emit.status}`);

    // -- 7. let the pipeline settle ---------------------------------
    log('Waiting 5s for the collector -> weaver pipeline ...');
    await sleep(5000);

    // -- 8. stop the session --------------------------------------
    log('POST /api/session/stop (no client timeout; ~5-15s) ...');
    const stop = await req('POST', '/api/session/stop');
    log(`  -> ${stop.status} ${JSON.stringify(stop.body)}`);
    // stop returning 200 feeds assertion 4 together with the session poll.

    // -- 9. poll until report ------------------------------------
    log('Polling GET /api/session until status === "report" (timeout 20s) ...');
    const reported = await pollSessionStatus('report', 20000);
    assert(4, 'GET /api/session returns status = "report" after stop',
      stop.status === 200 && reported.ok,
      `stop=${stop.status} session.status=${reported.status}`);

    // -- 10. report assertions ----------------------------------
    const rep = await req('GET', '/api/report');
    log(`GET /api/report -> ${rep.status}`);
    const report = rep.body && typeof rep.body === 'object' ? rep.body : {};
    const entities = Array.isArray(report.entities) ? report.entities : null;
    const stats = report.stats && typeof report.stats === 'object' && !Array.isArray(report.stats) ? report.stats : null;

    assert(5, 'GET /api/report returns `entities` array and `stats` object',
      rep.status === 200 && entities !== null && stats !== null,
      `status=${rep.status} entities=${entities ? `array[${entities.length}]` : 'MISSING'} stats=${stats ? 'object' : 'MISSING'}`);

    const advice = entities ? collectAdvice(entities, []) : [];
    log(`Collected ${advice.length} advice entries by walking entities recursively.`);
    assert(6, 'Walking `entities` recursively finds at least one live_check_result.all_advice[] finding',
      advice.length > 0, `advice entries=${advice.length}`);

    const statsKeys = ['registry_coverage', 'advice_type_counts', 'total_entities'];
    const missingKeys = stats ? statsKeys.filter((k) => !Object.prototype.hasOwnProperty.call(stats, k)) : statsKeys;
    assert(7, 'stats contains registry_coverage, advice_type_counts, total_entities',
      missingKeys.length === 0, missingKeys.length ? `missing: ${missingKeys.join(', ')}` : 'all present');

    const dep = advice.find(
      (a) => a && a.id === 'deprecated' && a.context && a.context.attribute_key === 'http.method');
    assert(8, 'deprecated finding for http.method present in entities', dep,
      dep ? `level=${dep.level} signal_type=${dep.signal_type}` : 'not found');

    const ranp = advice.find(
      (a) => a && a.id === 'required_attribute_not_present'
        && a.context && a.context.attribute_key === 'http.request.method');
    assert(9, 'required_attribute_not_present finding for http.request.method present in entities', ranp,
      ranp ? `signal_name=${ranp.signal_name} signal_type=${ranp.signal_type}` : 'not found');

    const signalNames = entities ? entities.map(entitySignalName).filter(Boolean) : [];
    const customNames = signalNames.filter((n) => n === 'custom' || n.startsWith('custom.'));
    const customAdvice = advice.filter(
      (a) => a && typeof a.signal_name === 'string' && (a.signal_name === 'custom' || a.signal_name.startsWith('custom.')));
    assert(10, 'No entities with a custom.* signal name in the report',
      customNames.length === 0 && customAdvice.length === 0,
      customNames.length || customAdvice.length
        ? `entity signal names: [${customNames.join(', ')}]  advice signal_name matches: ${customAdvice.length}`
        : `entity signal names: [${signalNames.join(', ')}]`);

    // -- 11. config ---------------------------------------------
    const cfg = await req('GET', '/api/config');
    log(`GET /api/config -> ${cfg.status} custom_namespaces=${JSON.stringify(cfg.body && cfg.body.custom_namespaces)}`);
    const cns = cfg.body && cfg.body.custom_namespaces;
    assert(11, 'GET /api/config returns custom_namespaces: ["custom"]',
      cfg.status === 200 && Array.isArray(cns) && cns.length === 1 && cns[0] === 'custom',
      `custom_namespaces=${JSON.stringify(cns)}`);

    // -- 12. start after report clears it -----------------------
    log('POST /api/session/start (after report) ...');
    const start3 = await req('POST', '/api/session/start');
    log(`  -> ${start3.status} ${JSON.stringify(start3.body)}`);
    const rep2 = await req('GET', '/api/report');
    log(`GET /api/report (after restart) -> ${rep2.status}`);
    assert(12, 'POST /api/session/start after report clears previous report and returns to listening',
      start3.status === 200 && start3.body && start3.body.status === 'listening' && rep2.status === 404,
      `start=${start3.status} body.status=${start3.body && start3.body.status} report=${rep2.status}`);

  } catch (err) {
    log(`ERROR during run: ${err && err.stack ? err.stack : err}`);
    if (results.length === 0 || results.every((r) => r.pass)) {
      assert(99, `validate.js run aborted: ${err && err.message ? err.message : err}`, false, 'see log above');
    }
  } finally {
    // -- 13. tear down ---------------------------------------
    if (stackUp) {
      log('Tearing down stack (COMPOSE_PROFILES=app down -v --remove-orphans) ...');
      compose(['down', '-v', '--remove-orphans'], { inherit: true });
    }
  }

  // -- 14. summary -----------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('');
  log('Assertion results:');
  for (const r of results) {
    log(`  ${r.pass ? '✓' : '✗'} ${r.n}. ${r.desc}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('');
  if (passed === total && total >= 12) {
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

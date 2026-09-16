#!/usr/bin/env node
/*
 * Phase-01 infrastructure validation. Fully autonomous.
 *
 *   1. docker compose -f docker-compose.test.yml up -d --wait
 *   2. Poll collector health (GET http://localhost:13133/) until 200
 *   3. Poll TCP connect to localhost:4320 (weaver admin) until open
 *   4. node ../test-app/index.js --scenario phase-01
 *   5. Wait 3s for weaver to process
 *   6. POST http://localhost:4320/stop
 *   7. Poll for <repo>/weaver-output/live_check.json
 *   8. Parse it
 *   9. Run assertions
 *  10. docker compose ... down -v --remove-orphans
 *  11. Print summary, exit 0 (all pass) / 1 (any fail)
 *
 * Only reads/writes under qa/. Never mutates implementation files.
 */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const COMPOSE_FILE = path.join(HERE, 'docker-compose.test.yml');
const REPORT_PATH = path.join(REPO_ROOT, 'weaver-output', 'live_check.json');
const TEST_APP = path.join(HERE, '..', 'test-app', 'index.js');

const log = (m) => console.log(`[QA] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UID/GID for the weaver container's `user:` and bind-mount write permissions.
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
const composeEnv = { ...process.env, UID: String(uid), GID: String(gid) };

function compose(args, opts = {}) {
  return spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    cwd: HERE,
    env: composeEnv,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    ...opts,
  });
}

function tcpOpen(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

async function pollHttp200(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status === 200) return true;
    } catch (_) {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function pollTcp(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpOpen(host, port)) return true;
    await sleep(1000);
  }
  return false;
}

async function pollFile(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
    await sleep(1000);
  }
  return false;
}

// Recursively collect every advice object from the sample tree.
function collectAdvice(node, acc) {
  if (Array.isArray(node)) {
    for (const x of node) collectAdvice(x, acc);
    return;
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
}

// Does any node whose name/metric_name matches `nameRe` carry advice in its subtree?
function subtreeAdviceForName(node, nameRe, acc) {
  if (Array.isArray(node)) {
    for (const x of node) subtreeAdviceForName(x, nameRe, acc);
    return;
  }
  if (node && typeof node === 'object') {
    const nm = node.name || node.metric_name;
    if (typeof nm === 'string' && nameRe.test(nm)) {
      collectAdvice(node, acc);
    }
    for (const k of Object.keys(node)) subtreeAdviceForName(node[k], nameRe, acc);
  }
}

// ---------------------------------------------------------------------------
const results = [];
const assert = (n, desc, pass, detail) => {
  results.push({ n, desc, pass: !!pass, detail: detail || '' });
};

async function main() {
  let stackUp = false;
  try {
    // -- pre-clean stale report -------------------------------------------
    if (fs.existsSync(REPORT_PATH)) {
      fs.rmSync(REPORT_PATH);
      log(`Removed stale report ${REPORT_PATH}`);
    }
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });

    // -- 1. bring the stack up ------------------------------------------------
    log('docker compose up -d --wait ...');
    compose(['down', '-v', '--remove-orphans'], { stdio: 'pipe' });
    const up = compose(['up', '-d', '--wait'], { inherit: true });
    stackUp = true;
    if (up.status !== 0) {
      throw new Error(`compose up exited ${up.status}`);
    }
    log('Stack reported healthy.');

    // -- 2. collector health -----------------------------------------------
    log('Polling collector health http://localhost:13133/ ...');
    const collectorOk = await pollHttp200('http://localhost:13133/', 30000);
    if (!collectorOk) throw new Error('collector health check never returned 200');
    log('Collector healthy.');

    // -- 3. weaver admin port --------------------------------------------
    log('Polling weaver admin TCP localhost:4320 ...');
    const weaverOk = await pollTcp('127.0.0.1', 4320, 30000);
    if (!weaverOk) throw new Error('weaver admin port 4320 never opened');
    log('Weaver admin port open.');

    // -- 4. emit synthetic OTLP/HTTP traffic ---------------------------------
    log('Running test app: scenario phase-01 (OTLP/HTTP JSON -> localhost:4318) ...');
    const emit = spawnSync('node', [TEST_APP, '--scenario', 'phase-01', '--endpoint', 'http://localhost:4318'], {
      encoding: 'utf8',
    });
    process.stdout.write(emit.stdout || '');
    process.stdout.write(emit.stderr || '');
    if (emit.status !== 0) throw new Error(`test app exited ${emit.status}`);

    // -- 5. let weaver process --------------------------------------------
    log('Waiting 3s for weaver to process ...');
    await sleep(3000);

    // -- 6. stop the session ------------------------------------------------
    log('POST http://localhost:4320/stop ...');
    try {
      const stopRes = await fetch('http://localhost:4320/stop', { method: 'POST' });
      log(`  /stop -> HTTP ${stopRes.status}`);
    } catch (e) {
      log(`  /stop request threw (${e.message}) — weaver may have closed the socket on stop, continuing`);
    }

    // -- 7. wait for the report -------------------------------------------
    log(`Polling for ${REPORT_PATH} ...`);
    const reportOk = await pollFile(REPORT_PATH, 15000);

    // -- 8. parse ---------------------------------------------------------
    let report = null;
    let parseErr = null;
    if (reportOk) {
      try {
        report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
      } catch (e) {
        parseErr = e;
      }
    }

    // -- 9. assertions ----------------------------------------------------
    assert(1, 'Report file exists and is valid JSON',
      reportOk && report && !parseErr,
      !reportOk ? 'file never appeared' : parseErr ? `parse error: ${parseErr.message}` : 'ok');

    const hasSamples = report && Array.isArray(report.samples);
    const hasStats = report && report.statistics && typeof report.statistics === 'object' && !Array.isArray(report.statistics);
    assert(2, 'Report has `samples` array and `statistics` object at top level',
      hasSamples && hasStats,
      `samples:${hasSamples ? 'array' : 'MISSING'} statistics:${hasStats ? 'object' : 'MISSING'}`);

    assert(3, 'statistics contains `total_entities` key',
      hasStats && Object.prototype.hasOwnProperty.call(report.statistics, 'total_entities'),
      hasStats ? `total_entities=${report.statistics && report.statistics.total_entities}` : 'no statistics');

    const advice = [];
    if (hasSamples) collectAdvice(report.samples, advice);
    log(`Collected ${advice.length} advice entries from the sample tree.`);

    const findDeprecated = (key) => advice.find(
      (a) => a.id === 'deprecated' && a.level === 'violation' && a.context && a.context.attribute_key === key);

    const d4 = findDeprecated('http.method');
    assert(4, 'deprecated (violation) finding for http.method', d4,
      d4 ? `signal_type=${d4.signal_type}` : 'not found');

    const d5 = findDeprecated('http.url');
    assert(5, 'deprecated (violation) finding for http.url', d5,
      d5 ? `signal_type=${d5.signal_type}` : 'not found');

    const d6 = findDeprecated('http.status_code');
    assert(6, 'deprecated (violation) finding for http.status_code', d6,
      d6 ? `signal_type=${d6.signal_type}` : 'not found');

    const tm = advice.find(
      (a) => a.id === 'type_mismatch' && a.context && a.context.attribute_key === 'http.status_code');
    assert(7, 'type_mismatch finding for http.status_code', tm,
      tm ? `expected=${tm.context.expected} got=${tm.context.attribute_type}` : 'not found');

    const dlog = advice.find(
      (a) => a.id === 'deprecated' && a.level === 'violation'
        && a.context && a.context.attribute_key === 'code.function' && a.signal_type === 'log');
    assert(8, 'deprecated (violation) finding for code.function on the log record', dlog,
      dlog ? `signal_type=${dlog.signal_type}` : 'not found (or signal_type != log)');

    const ranp = advice.find(
      (a) => a.id === 'required_attribute_not_present' && a.level === 'violation'
        && a.context && a.context.attribute_key === 'http.request.method'
        && a.signal_name === 'http.server.request.duration' && a.signal_type === 'metric');
    assert(9, 'required_attribute_not_present (violation) for http.request.method on http.server.request.duration metric',
      ranp, ranp ? 'found' : 'not found');

    // no findings on any custom.* signal
    const customBySignalName = advice.filter((a) => typeof a.signal_name === 'string' && /^custom\./.test(a.signal_name));
    const customSubtree = [];
    if (hasSamples) subtreeAdviceForName(report.samples, /^custom\./, customSubtree);
    const customClean = customBySignalName.length === 0 && customSubtree.length === 0;
    assert(10, 'No findings on any custom.* signal', customClean,
      customClean ? 'clean' : `signal_name matches:${customBySignalName.length} subtree advice:${customSubtree.length} (${[...customBySignalName, ...customSubtree].map((a) => a.id).join(',')})`);

    const depCount = hasStats && report.statistics.advice_type_counts
      ? report.statistics.advice_type_counts.deprecated : undefined;
    assert(11, 'statistics.advice_type_counts.deprecated > 0', typeof depCount === 'number' && depCount > 0,
      `deprecated=${depCount}`);

    // transport confirmation — 4..9 only reach the report via the OTLP/HTTP path
    const httpPathOk = [4, 5, 6, 7, 8, 9].every((n) => results.find((r) => r.n === n).pass);
    assert(12, 'OTLP/HTTP transport confirmed (span+log+metric findings 4-9 all present via the HTTP path)',
      httpPathOk, httpPathOk ? 'all HTTP-delivered findings present' : 'one or more of 4-9 failed');

    // bonus coverage: globally-suppressed ids must not leak into the report
    const leaked = advice.filter((a) => a.id === 'not_stable' || a.id === 'missing_namespace');
    assert(13, 'Globally-suppressed ids (not_stable / missing_namespace) absent from report',
      leaked.length === 0, leaked.length ? `leaked: ${leaked.map((a) => a.id).join(',')}` : 'none');

  } finally {
    // -- 10. tear down --------------------------------------------------
    if (stackUp) {
      log('Tearing down stack (down -v --remove-orphans) ...');
      compose(['down', '-v', '--remove-orphans'], { inherit: true });
    }
  }

  // -- 11. summary ------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log('');
  log('Assertion results:');
  for (const r of results) {
    log(`  ${r.pass ? '✓' : '✗'} ${r.n}. ${r.desc}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('');
  if (passed === total) {
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

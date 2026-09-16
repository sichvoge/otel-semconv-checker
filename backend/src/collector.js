'use strict';

// The OTel Collector runs continuously, but its OTLP/gRPC exporter pins the
// address it first dialed and backs off exponentially while Weaver is down
// (the whole idle period). By the time a short session brings Weaver up, the
// collector is deep in backoff and misses the window.
//
// So the backend restarts the collector once Weaver is healthy at the start of
// every session: a fresh collector dials the already-listening Weaver on its
// first export, with no accumulated backoff.

const Docker = require('dockerode');

const docker = new Docker();

const CONTAINER = process.env.COLLECTOR_CONTAINER || 'osc-collector';
const HEALTH_URL = (process.env.COLLECTOR_HEALTH_URL || 'http://collector:13133/').replace(/\/$/, '') + '/';
const HEALTH_TIMEOUT_MS = Number(process.env.COLLECTOR_HEALTH_TIMEOUT_MS || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastErr = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(`collector did not become healthy within ${HEALTH_TIMEOUT_MS}ms: ${lastErr}`);
}

async function restart() {
  await docker.getContainer(CONTAINER).restart({ t: 3 });
  await waitForHealthy();
}

module.exports = { restart, waitForHealthy, CONTAINER };

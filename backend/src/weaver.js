'use strict';

// Weaver container lifecycle, driven over the Docker API.
//
// Weaver is a service in docker-compose.yml but is NOT meant to run in the idle
// state, so the backend owns its lifecycle:
//   - on boot: force it stopped (idle)
//   - session start: `docker start` the existing container; it re-runs
//     `registry live-check` and re-binds the OTLP listener
//   - session stop: POST the admin /stop endpoint so Weaver flushes
//     live_check.json and exits cleanly (SIGKILL would not flush)
//
// The container is reused across sessions (its filesystem — and the resolved
// registry cache under $HOME — survives start/stop), so restarts are fast.

const Docker = require('dockerode');

const docker = new Docker(); // unix:///var/run/docker.sock

const CONTAINER = process.env.WEAVER_CONTAINER || 'osc-weaver';
const ADMIN_URL = (process.env.WEAVER_ADMIN_URL || 'http://weaver:4320').replace(/\/$/, '');
const HEALTH_TIMEOUT_MS = Number(process.env.WEAVER_HEALTH_TIMEOUT_MS || 45000);
const EXIT_TIMEOUT_MS = Number(process.env.WEAVER_EXIT_TIMEOUT_MS || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get() {
  return docker.getContainer(CONTAINER);
}

async function inspect() {
  try {
    return await get().inspect();
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

// Wait for the weaver container to be created by docker-compose.
async function waitForContainer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await inspect();
    if (info) return info;
    if (Date.now() > deadline) {
      throw new Error(
        `weaver container "${CONTAINER}" does not exist — is it defined in docker-compose.yml?`,
      );
    }
    await sleep(500);
  }
}

// Idle state: no weaver running. Used on boot and defensively.
async function forceStop() {
  const info = await inspect();
  if (info && info.State && info.State.Running) {
    await get().stop({ t: 3 }).catch((err) => {
      if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
    });
  }
}

async function waitForHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ADMIN_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastErr = new Error(`admin /health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(1000);
  }
  throw new Error(`weaver did not become healthy within ${HEALTH_TIMEOUT_MS}ms: ${lastErr}`);
}

async function start() {
  await waitForContainer();
  await forceStop(); // clear any stale run
  await get().start();
  await waitForHealthy();
}

async function waitForExit() {
  const c = get();
  const timeout = sleep(EXIT_TIMEOUT_MS).then(() => 'timeout');
  const exited = c.wait({ condition: 'not-running' }).then(() => 'exited').catch(() => 'exited');
  const outcome = await Promise.race([exited, timeout]);
  if (outcome === 'timeout') {
    // Weaver ignored /stop or hung mid-flush — kill it so we don't wedge.
    await c.stop({ t: 2 }).catch(() => {});
  }
}

// Graceful stop: flushes the report, then exits.
async function stop() {
  try {
    await fetch(`${ADMIN_URL}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Weaver often drops the connection as it exits — that is not an error.
  }
  await waitForExit();
}

async function isRunning() {
  const info = await inspect();
  return Boolean(info && info.State && info.State.Running);
}

module.exports = { start, stop, forceStop, isRunning, waitForContainer, CONTAINER };

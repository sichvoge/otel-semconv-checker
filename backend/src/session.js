'use strict';

// The session state machine:  idle → listening → report → (listening | idle)
//
// One session at a time. `start` boots Weaver; `stop` flushes and parses the
// report. Transitions are serialised with a simple in-flight guard so a
// double-click can't drive Weaver into a bad state.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const weaver = require('./weaver');
const collector = require('./collector');
const counts = require('./counts');
const { parseReport } = require('./report');

const WEAVER_OUTPUT_DIR = process.env.WEAVER_OUTPUT_DIR || '/app/weaver-output';
const REPORT_FILE = path.join(WEAVER_OUTPUT_DIR, 'live_check.json');
const REPORT_WAIT_MS = Number(process.env.REPORT_WAIT_MS || 15000);

const OTLP_GRPC = process.env.OTLP_GRPC_ADDR || 'localhost:4317';
const OTLP_HTTP = process.env.OTLP_HTTP_ADDR || 'localhost:4318';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readReportFile() {
  const text = await fsp.readFile(REPORT_FILE, 'utf8');
  return JSON.parse(text);
}

async function waitForReportFile(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const raw = await readReportFile();
      if (raw && typeof raw === 'object') return raw;
    } catch (err) {
      lastErr = err;
    }
    await sleep(300);
  }
  throw new HttpError(500, `weaver report was not produced within ${timeoutMs}ms: ${lastErr}`);
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

class SessionManager {
  constructor() {
    this.status = 'idle'; // idle | listening | report | error
    this.startedAt = null;
    this.stoppedAt = null;
    this.rawReport = null;
    this._busy = false;
    this._countsBaseline = { spans: 0, metrics: 0, logs: 0 };
  }

  async init() {
    // The idle state is logical: we do NOT touch the weaver container on boot
    // (docker-compose starts it, and phase-1's standalone stack depends on it
    // staying up). `start()` force-stops and re-runs weaver regardless of its
    // prior state, so a stray running weaver during idle is harmless.
    this.status = 'idle';
    try {
      await weaver.waitForContainer(5000);
    } catch (err) {
      console.error(`[session] init: ${err.message}`);
    }
  }

  _guard() {
    if (this._busy) throw new HttpError(409, 'a session transition is already in progress');
  }

  async start() {
    this._guard();
    if (this.status === 'listening') throw new HttpError(409, 'session already listening');

    this._busy = true;
    try {
      safeUnlink(REPORT_FILE);
      this.rawReport = null;
      await weaver.start();
      // Weaver is listening now — restart the collector so it dials fresh.
      await collector.restart();
      // The collector restart zeroes its internal counters; snapshot a baseline
      // anyway so live counts are always reported relative to session start.
      this._countsBaseline = await counts.scrape().catch(() => ({ spans: 0, metrics: 0, logs: 0 }));
      this.status = 'listening';
      this.startedAt = new Date().toISOString();
      this.stoppedAt = null;
    } catch (err) {
      this.status = 'error';
      throw err instanceof HttpError ? err : new HttpError(500, `failed to start weaver: ${err.message}`);
    } finally {
      this._busy = false;
    }
  }

  async stop() {
    this._guard();
    if (this.status !== 'listening') throw new HttpError(400, 'no session is listening');

    this._busy = true;
    try {
      await weaver.stop();
      this.rawReport = await waitForReportFile(REPORT_WAIT_MS);
      this.status = 'report';
      this.stoppedAt = new Date().toISOString();
    } catch (err) {
      this.status = 'error';
      throw err instanceof HttpError ? err : new HttpError(500, `failed to stop weaver: ${err.message}`);
    } finally {
      this._busy = false;
    }
  }

  async signalCounts() {
    if (this.status === 'listening') {
      // Live counts: scrape the collector's internal telemetry and report the
      // delta since session start. Any scrape failure -> zeros, never a 500.
      try {
        const cur = await counts.scrape();
        const base = this._countsBaseline || { spans: 0, metrics: 0, logs: 0 };
        return {
          spans: Math.max(0, cur.spans - base.spans),
          metrics: Math.max(0, cur.metrics - base.metrics),
          logs: Math.max(0, cur.logs - base.logs),
        };
      } catch (err) {
        console.error(`[session] live count scrape failed: ${err.message}`);
        return { spans: 0, metrics: 0, logs: 0 };
      }
    }
    if (this.status === 'report' && this.rawReport && this.rawReport.statistics) {
      const byType = this.rawReport.statistics.total_entities_by_type || {};
      return {
        spans: byType.span || 0,
        metrics: byType.metric || 0,
        logs: byType.log || 0,
      };
    }
    return { spans: 0, metrics: 0, logs: 0 };
  }

  async view() {
    return {
      status: this.status,
      started_at: this.startedAt,
      stopped_at: this.stoppedAt,
      otlp_grpc: OTLP_GRPC,
      otlp_http: OTLP_HTTP,
      signal_counts: await this.signalCounts(),
    };
  }

  report(config, metricRequirements) {
    if (!this.rawReport) return null;
    return parseReport(this.rawReport, config, metricRequirements);
  }
}

module.exports = { SessionManager, HttpError };

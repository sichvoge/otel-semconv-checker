#!/usr/bin/env node
/*
 * Synthetic OTLP/HTTP JSON emitter for the OTel SemConv Checker phase QA harness.
 *
 * - No @opentelemetry/* dependencies. Hand-rolled OTLP/JSON + plain fetch.
 * - Sends OTLP/HTTP JSON (Content-Type: application/json) to
 *     <endpoint>/v1/traces
 *     <endpoint>/v1/logs
 *     <endpoint>/v1/metrics
 *   Default endpoint: http://localhost:4318
 *
 * Usage:
 *   node index.js --scenario phase-01
 *   node index.js --scenario phase-01 --endpoint http://localhost:4318
 *   node index.js --scenario phase-01 --dry-run     # print payloads, send nothing, exit 0
 */

'use strict';

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { scenario: 'phase-01', endpoint: 'http://localhost:4318', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario') args.scenario = argv[++i];
    else if (a === '--endpoint') args.endpoint = argv[++i];
    else if (a === '--dry-run' || a === '--dryrun') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--scenario=')) args.scenario = a.slice('--scenario='.length);
    else if (a.startsWith('--endpoint=')) args.endpoint = a.slice('--endpoint='.length);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function hex(bytes) {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
  return b.toString('hex');
}

const nowNano = () => String(Date.now() * 1e6);
const nanoMinus = (ms) => String((Date.now() - ms) * 1e6);

// OTLP/JSON AnyValue builders
const sv = (v) => ({ stringValue: String(v) });
const iv = (v) => ({ intValue: String(v) });
const dv = (v) => ({ doubleValue: v });
const bv = (v) => ({ boolValue: v });

const attr = (key, value) => ({ key, value });

function resource(serviceName) {
  return { attributes: [attr('service.name', sv(serviceName))] };
}

const SCOPE = { name: 'otel-semconv-checker-test-app', version: '1.0.0' };

// ---------------------------------------------------------------------------
// scenario payload builders
// ---------------------------------------------------------------------------

// One span: my-service, kind 2 (SERVER), deprecated http.* attrs, wrong type on
// http.status_code (string, registry expects int).
function tracesPayload() {
  const start = nanoMinus(20);
  const end = nowNano();
  return {
    resourceSpans: [
      {
        resource: resource('my-service'),
        scopeSpans: [
          {
            scope: SCOPE,
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name: 'my-service',
                kind: 2,
                startTimeUnixNano: start,
                endTimeUnixNano: end,
                attributes: [
                  attr('http.method', sv('GET')),
                  attr('http.url', sv('http://example.com/api')),
                  attr('http.status_code', sv('200')),
                ],
                status: {},
              },
            ],
          },
        ],
      },
    ],
  };
}

// One log record: service.name my-service, deprecated code.function attribute.
function logsPayload() {
  return {
    resourceLogs: [
      {
        resource: resource('my-service'),
        scopeLogs: [
          {
            scope: SCOPE,
            logRecords: [
              {
                timeUnixNano: nowNano(),
                observedTimeUnixNano: nowNano(),
                severityNumber: 9,
                severityText: 'INFO',
                body: sv('request handled'),
                attributes: [attr('code.function', sv('handle'))],
              },
            ],
          },
        ],
      },
    ],
  };
}

// Two metrics under my-service:
//   http.server.request.duration - histogram, single data point, only
//     http.response.status_code (int 200). Deliberately omits http.request.method.
//   custom.request.count - monotonic cumulative sum, single data point,
//     custom.user_id="abc" (custom namespace -> suppressed by .weaver.toml).
function metricsPayload() {
  const start = nanoMinus(60000);
  const t = nowNano();
  return {
    resourceMetrics: [
      {
        resource: resource('my-service'),
        scopeMetrics: [
          {
            scope: SCOPE,
            metrics: [
              {
                name: 'http.server.request.duration',
                unit: 's',
                description: 'Duration of HTTP server requests.',
                histogram: {
                  aggregationTemporality: 2, // CUMULATIVE
                  dataPoints: [
                    {
                      startTimeUnixNano: start,
                      timeUnixNano: t,
                      count: '1',
                      sum: 0.42,
                      bucketCounts: ['0', '1', '0'],
                      explicitBounds: [0.1, 1.0],
                      min: 0.42,
                      max: 0.42,
                      attributes: [attr('http.response.status_code', iv(200))],
                    },
                  ],
                },
              },
              {
                name: 'custom.request.count',
                unit: '{request}',
                description: 'Proprietary request counter.',
                sum: {
                  aggregationTemporality: 2, // CUMULATIVE
                  isMonotonic: true,
                  dataPoints: [
                    {
                      startTimeUnixNano: start,
                      timeUnixNano: t,
                      asInt: '5',
                      attributes: [attr('custom.user_id', sv('abc'))],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

// phase-04: superset of phase-01 with richer span violations. Same my-service
// SERVER span (deprecated http.method / http.url / http.status_code, plus
// http.status_code sent as a string -> type_mismatch), extended with more
// deprecated HTTP/net attributes, and a second my-service CLIENT span carrying
// further deprecated attributes so the "span my-service" group has multiple
// broken instances. Logs + metrics payloads are unchanged from phase-01, so the
// deprecated code.function log finding and the required_attribute_not_present
// finding for http.request.method on http.server.request.duration still appear.
function tracesPayloadPhase04() {
  const start = nanoMinus(20);
  const end = nowNano();
  return {
    resourceSpans: [
      {
        resource: resource('my-service'),
        scopeSpans: [
          {
            scope: SCOPE,
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name: 'my-service',
                kind: 2, // SERVER
                startTimeUnixNano: start,
                endTimeUnixNano: end,
                attributes: [
                  attr('http.method', sv('GET')), // deprecated -> http.request.method
                  attr('http.url', sv('http://example.com/api')), // deprecated -> url.full
                  attr('http.status_code', sv('200')), // string: deprecated + type_mismatch
                  attr('http.scheme', sv('http')), // deprecated -> url.scheme
                  attr('http.target', sv('/api?q=1')), // deprecated -> url.path / url.query
                  attr('http.flavor', sv('1.1')), // deprecated -> network.protocol.version
                  attr('net.peer.name', sv('example.com')), // deprecated -> server.address
                  attr('net.peer.port', iv(80)), // deprecated -> server.port
                ],
                status: {},
              },
              {
                traceId: hex(16),
                spanId: hex(8),
                name: 'my-service',
                kind: 3, // CLIENT
                startTimeUnixNano: start,
                endTimeUnixNano: end,
                attributes: [
                  attr('http.method', sv('POST')), // deprecated
                  attr('http.host', sv('example.com')), // deprecated -> server.address / server.port
                  attr('http.user_agent', sv('synthetic/1.0')), // deprecated -> user_agent.original
                ],
                status: {},
              },
            ],
          },
        ],
      },
    ],
  };
}

// phase-05: superset of phase-04. Everything phase-04 emits is emitted
// unchanged (same my-service SERVER + CLIENT spans, same deprecated code.function
// log, same http.server.request.duration + custom.request.count metrics), plus
// one extra `http.request` span. That span is a belt-and-braces marker that the
// `http` namespace is active for the "what is missing?" tab (the base scenario
// already activates it via http.server.request.duration), and it adds a span-type
// signal to the mix. It carries the current `http.request.method` attribute so it
// is a plain namespace-activation signal rather than a pile of new violations.
function tracesPayloadPhase05() {
  const payload = tracesPayloadPhase04();
  const start = nanoMinus(20);
  const end = nowNano();
  payload.resourceSpans[0].scopeSpans[0].spans.push({
    traceId: hex(16),
    spanId: hex(8),
    name: 'http.request',
    kind: 3, // CLIENT
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: [
      attr('http.request.method', sv('GET')),
      attr('server.address', sv('example.com')),
      attr('server.port', iv(443)),
    ],
    status: {},
  });
  return payload;
}

const SCENARIOS = {
  'phase-01': () => [
    { signal: 'traces', path: '/v1/traces', payload: tracesPayload() },
    { signal: 'logs', path: '/v1/logs', payload: logsPayload() },
    { signal: 'metrics', path: '/v1/metrics', payload: metricsPayload() },
  ],
  'phase-04': () => [
    { signal: 'traces', path: '/v1/traces', payload: tracesPayloadPhase04() },
    { signal: 'logs', path: '/v1/logs', payload: logsPayload() },
    { signal: 'metrics', path: '/v1/metrics', payload: metricsPayload() },
  ],
  'phase-05': () => [
    { signal: 'traces', path: '/v1/traces', payload: tracesPayloadPhase05() },
    { signal: 'logs', path: '/v1/logs', payload: logsPayload() },
    { signal: 'metrics', path: '/v1/metrics', payload: metricsPayload() },
  ],
};

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------
async function send(endpoint, item) {
  const url = endpoint.replace(/\/+$/, '') + item.path;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item.payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} -> HTTP ${res.status}: ${text}`);
  }
  return { url, status: res.status, body: text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log('Usage: node index.js --scenario <name> [--endpoint <url>] [--dry-run]');
    console.log('Scenarios: ' + Object.keys(SCENARIOS).join(', '));
    process.exit(0);
  }

  const build = SCENARIOS[args.scenario];
  if (!build) {
    console.error(`Unknown scenario: ${args.scenario}`);
    console.error('Known scenarios: ' + Object.keys(SCENARIOS).join(', '));
    process.exit(2);
  }

  const items = build();

  if (args.dryRun) {
    console.log(`[test-app] scenario=${args.scenario} endpoint=${args.endpoint} DRY RUN (nothing sent)`);
    for (const item of items) {
      console.log(`\n=== ${item.signal.toUpperCase()}  POST ${args.endpoint}${item.path} ===`);
      console.log(JSON.stringify(item.payload, null, 2));
    }
    console.log(`\n[test-app] dry run complete: ${items.length} payload(s) would be sent.`);
    process.exit(0);
  }

  console.log(`[test-app] scenario=${args.scenario} endpoint=${args.endpoint}`);
  for (const item of items) {
    const r = await send(args.endpoint, item);
    console.log(`[test-app] ${item.signal.padEnd(7)} -> HTTP ${r.status} ${r.body}`);
  }
  console.log(`[test-app] sent ${items.length} signal payload(s).`);
}

main().catch((err) => {
  console.error(`[test-app] ERROR: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

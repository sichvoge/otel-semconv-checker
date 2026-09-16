# OTel SemConv Checker — Phase 1: Infrastructure

Reference: `references/SPEC.md`
All paths relative to project root.

---

## QA model

Every phase has a `qa/phase-XX-<name>/` folder. Running `node validate.js`
from that folder is fully autonomous:
1. Spins up the phase-specific Docker Compose stack
2. Waits for services to be ready
3. Runs the test app with the phase scenario
4. Triggers stop / report generation where applicable
5. Runs assertions
6. Tears down the stack
7. Exits `0` (all pass) or `1` (any fail)

### Test app

A single Node.js test app at `qa/test-app/`. Accepts a `--scenario` flag:

```sh
node index.js --scenario phase-01   # spans + logs + custom metric only
node index.js --scenario phase-04   # adds richer span violations
node index.js --scenario phase-05   # adds http.* namespace to trigger missing tab
```

Each scenario is a superset of the previous. Sends OTLP/HTTP to
`localhost:4318` by default. Configurable via `--endpoint`.

### Synthetic test signals

| Signal | Type | Finding expected |
|--------|------|-----------------|
| `my-service` span | span | `deprecated` (violation): `http.method`, `http.url`, `http.status_code` |
| `my-service` span | span | `type_mismatch`: `http.status_code` sent as string, should be int |
| log record | log | `deprecated` (violation): `code.function` (deprecated — folded into `code.function.name`) |
| `http.server.request.duration` metric | metric | `required_attribute_not_present` (violation): `http.request.method` omitted from the data point |
| `custom.request.count` metric | metric | suppressed — `custom.*` namespace |
| `http.request` span (phase-05+) | span | triggers missing tab: `http.server.request.duration` gaps |

Note: Weaver does NOT flag required-but-absent attributes on spans, and never
under the id `missing_attribute`. `missing_attribute` fires only when an emitted
attribute is not in the registry at all. Required-but-absent checking fires as
`required_attribute_not_present` / `recommended_attribute_not_present` and only
where Weaver resolves the signal to a registry group — metric data points (by
metric name) and log records (by `event.name`).

The `http.server.request.duration` data point above, carrying only
`http.response.status_code`, also produces other `*_attribute_not_present`
findings (`url.scheme`, `network.protocol.*`, `server.*`, …). Assertions must
check for the *presence* of a specific finding, not an exact finding set.

---

## Phase 1: Infrastructure

**Outcome:** Weaver and the OTel Collector run via Docker Compose. The stack
accepts OTLP/HTTP on port 4318 and OTLP/gRPC on port 4317. Sending synthetic
traffic and triggering stop produces a valid `live_check.json` containing the
expected violations. No backend, no frontend.

### What to build

#### `docker-compose.yml`

Two services: `collector` and `weaver`.

**collector** (`otel/opentelemetry-collector:latest`):
- Accepts OTLP/HTTP on port 4318 (published externally)
- Accepts OTLP/gRPC on port 4317 (published externally)
- Forwards all signals to Weaver via OTLP/gRPC internally
- Config: `collector-config.yaml` mounted into container

**weaver** (`otel/weaver:latest`):
- Runs `registry live-check`
- gRPC listener internal only (not published)
- Admin port 4320 published for `/stop`
- Output volume: `weaver-output` bind-mounted to `./weaver-output/`
- Config: `.weaver.toml` mounted into container
- `restart: "no"`
- `user: "${UID}:${GID}"`, `HOME=/tmp/weaver`

#### `collector-config.yaml`

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317

exporters:
  # Weaver's gRPC OTLP receiver rejects compressed payloads — send uncompressed.
  # (`otlp_grpc`; the bare `otlp` exporter alias is deprecated in collector 0.160.)
  otlp_grpc:
    endpoint: weaver:4317
    compression: none
    tls:
      insecure: true

extensions:
  health_check:
    endpoint: 0.0.0.0:13133

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_grpc]
    metrics:
      receivers: [otlp]
      exporters: [otlp_grpc]
    logs:
      receivers: [otlp]
      exporters: [otlp_grpc]
```

#### `.weaver.toml`

```toml
# Section key MUST be `live-check` (hyphen). Weaver looks up the per-command
# config by that literal key; `[live_check]` (underscore) is silently ignored,
# leaving the gRPC listener on loopback and the whole stack non-functional.
[live-check]
format = "json"

[live-check.otlp]
grpc_address = "0.0.0.0"
grpc_port = 4317
admin_port = 4320
inactivity_timeout = 0

# not_stable and missing_namespace are too noisy — suppress globally.
[[live-check.finding_filters]]
exclude = ["not_stable", "missing_namespace"]

# Custom-namespace signals only: drop the namespace / missing-signal findings.
# `sample_names` is the filter's scope (finding dropped only when its sample name
# matches AND its id is in `exclude`). `exclude_samples` would NOT work here —
# Weaver ORs it with `exclude`, dropping these ids for every signal.
[[live-check.finding_filters]]
exclude = ["illegal_namespace", "extends_namespace", "missing_attribute", "missing_metric"]
sample_names = ["custom.*"]

# Belt-and-braces: drop every remaining finding on custom-namespace samples.
[[live-check.finding_filters]]
exclude_samples = ["custom.*"]
```

The builder also passes `--otlp-grpc-address`, `--otlp-grpc-port`,
`--admin-port`, `--inactivity-timeout` and `--format json` on the Weaver command
line (CLI overrides config) as a backstop, and gates the collector on a Weaver
healthcheck (`nc -z 127.0.0.1 4317`) since Weaver binds the listener only after
resolving the registry (~5-10s).

Note: use a bind mount (`./weaver-output:/tmp/weaver-output`) not a named
volume so `validate.js` can read `live_check.json` directly from the host.

### QA

#### Folder structure

```
qa/
├── BUILDER-AGENT.md
├── QA-AGENT.md
├── test-app/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js
└── phase-01-infrastructure/
    ├── docker-compose.test.yml
    ├── validate.js
    └── expected/
        └── findings.json
```

#### `qa/test-app/index.js` — phase-01 scenario

Emits via OTLP/HTTP. Sends:
- One span `my-service` with:
  - `http.method="GET"` (deprecated)
  - `http.url="http://example.com/api"` (deprecated)
  - `http.status_code="200"` (deprecated AND wrong type — should be int)
- One log record with `code.function="handle"` (deprecated — value should be
  folded into `code.function.name`)
- One metric `http.server.request.duration` as a histogram data point carrying
  only `http.response.status_code`, deliberately omitting `http.request.method`
  (a required attribute on the data point)
- One metric `custom.request.count` with `custom.user_id="abc"` (custom namespace)

#### `qa/phase-01-infrastructure/validate.js` steps

```
1.  [QA] docker compose -f docker-compose.test.yml up -d --wait
       (weaver has a healthcheck; --wait blocks until collector + weaver are ready)
2.  [QA] Poll GET http://localhost:13133/ until 200 (collector health, timeout 30s)
3.  [QA] Poll TCP connect to localhost:4320 until open (weaver admin, timeout 30s).
       Do NOT POST /stop here — that ends the session.
4.  [QA] node ../test-app/index.js --scenario phase-01
5.  [QA] Wait 3s for Weaver to process
6.  [QA] POST http://localhost:4320/stop
7.  [QA] Poll for ./weaver-output/live_check.json (timeout 15s)
8.  [QA] Parse live_check.json
9.  [QA] Run assertions
10. [QA] docker compose -f docker-compose.test.yml down -v
11. [QA] Print summary, exit 0 or 1
```

#### Assertions — phase 1

| # | Assertion |
|---|-----------|
| 1 | Report file exists and is valid JSON |
| 2 | Report has `samples` array and `statistics` object at top level |
| 3 | `statistics` object contains `total_entities` key |
| 4 | `deprecated` finding (violation) for `http.method` |
| 5 | `deprecated` finding (violation) for `http.url` |
| 6 | `deprecated` finding (violation) for `http.status_code` |
| 7 | `type_mismatch` finding for `http.status_code` |
| 8 | `deprecated` finding (violation) for `code.function` on the log record |
| 9 | `required_attribute_not_present` finding (violation) for `http.request.method` on the `http.server.request.duration` metric |
| 10 | No findings on any `custom.*` signal |
| 11 | `statistics.advice_type_counts.deprecated` > 0 |
| 12 | OTLP/HTTP transport confirmed (assertions 4–9 pass via HTTP path) |

---

---

## Project file structure

```
otel-semconv-checker/
├── SPEC.md
├── PLAN.md
├── BUILDER-AGENT.md          # copied from qa/ to root for easy reference
├── QA-AGENT.md
├── docker-compose.yml
├── collector-config.yaml
├── .weaver.toml
├── semconv-checker.config.yaml
├── weaver-output/            # bind mount — gitignored
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js
│       ├── routes/
│       │   ├── session.js
│       │   └── report.js
│       └── weaver.js
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── components/
│       ├── hooks/
│       └── styles/
│           └── index.css
├── scripts/
│   └── fetch-metric-requirements.js
└── qa/
    ├── BUILDER-AGENT.md
    ├── QA-AGENT.md
    ├── test-app/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── index.js
    ├── phase-01-infrastructure/
    ├── phase-02-backend/
    ├── phase-03-frontend-states/
    ├── phase-04-frontend-broken/
    ├── phase-05-frontend-missing/
    └── phase-06-metric-requirements/
```
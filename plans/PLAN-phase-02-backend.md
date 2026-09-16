# OTel SemConv Checker — Phase 2: Backend

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
| log record | log | `deprecated` (violation): `code.function` |
| `http.server.request.duration` metric | metric | `required_attribute_not_present` (violation): `http.request.method` omitted from the data point |
| `custom.request.count` metric | metric | suppressed — `custom.*` namespace |
| `http.request` span (phase-05+) | span | triggers missing tab: `http.server.request.duration` gaps |

See `PLAN-phase-01-infrastructure.md` for the full scenario detail and the note
on why Weaver never emits `missing_attribute` for required-but-absent attributes.

---

## Phase 2: Backend

**Outcome:** The backend is running. It manages the Weaver container lifecycle
via Docker API, parses the report, loads config, and exposes the REST API.
All endpoints are testable via HTTP. Full end-to-end session via the API
produces a correctly parsed report.

### What to build

- `backend/` Node.js + Express app (`dockerode`, `express`, `js-yaml`; pinned lockfile)
- Session state machine (`idle → listening → report → listening|idle`), one session at a time,
  transitions serialised with an in-flight guard (concurrent `start` → 409)
- Weaver lifecycle over the Docker API:
  - `start`: `docker start` the existing `osc-weaver` container (it re-runs
    `registry live-check`), poll its admin `/health` until ready, then **restart the
    collector** (`osc-collector`) so its gRPC exporter dials the now-listening
    Weaver fresh instead of sitting in accumulated backoff
  - `stop`: `POST http://weaver:4320/stop` (flushes `live_check.json` and exits —
    SIGKILL would not flush), wait for the container to exit
  - The idle state is logical: the backend does NOT stop Weaver on boot (compose
    starts it, and phase-1's standalone stack needs it up). `start` force-stops
    and re-runs Weaver regardless of prior state.
- Detect the flushed report by **polling** `weaver-output/live_check.json` after
  stop (`fs.watch` is unreliable over bind mounts).
- Report parser: reads `{ "samples": [...], "statistics": {...} }` — an object,
  not an array. `samples[]` entries are single-key wrappers
  (`{resource:…}`, `{instrumentation_scope:…}`, `{span:…}`, `{log:…}`, `{metric:…}`);
  findings are nested at `…​.live_check_result.all_advice[]` at whatever level they
  apply. API response: `entities` = `samples` with custom-namespace signals
  removed (see below), `stats` = `statistics` verbatim.
- **Custom-namespace filter (backend side):** drop any `samples[]` entry whose
  signal name (`metric`/`span`/`log` `.name`) starts with a `custom_namespaces`
  prefix, so `GET /api/report` carries no `custom.*` entities. The frontend still
  runs the full transform later (SPEC: "both").
- Config loader: reads `semconv-checker.config.yaml` **once at startup** (path via
  `SEMCONV_CONFIG_PATH`). Missing file → all-empty defaults.
- `signal_counts` in `GET /api/session`: from `statistics.total_entities_by_type`
  once a report exists; `{0,0,0}` during `listening` (live counters are a later phase).
- REST API: `GET /api/session`, `POST /api/session/start`,
  `POST /api/session/stop`, `GET /api/report` (404 when none), `GET /api/config`,
  `GET /api/health`
- Docker Compose updated:
  - `backend` service — `build: ./backend`, `/var/run/docker.sock` mount,
    `./weaver-output` and `./semconv-checker.config.yaml` mounts, port `3001`,
    `depends_on: weaver (service_healthy)`, and **`profiles: ["app"]`** so the
    phase-1 stack (collector + weaver only) is unchanged
  - `weaver` gets a **static IP** (`172.28.71.10`, on a dedicated
    `172.28.71.0/24` subnet) and `collector-config.yaml` targets that IP directly
    — `docker start` hands a restarted container a new IP and the collector's
    gRPC exporter pins the first address it resolved
  - collector-config gains `retry_on_failure` (short `max_interval`,
    `max_elapsed_time: 0`) + `sending_queue` so telemetry emitted early in a
    session is held until Weaver reconnects
- A repo-root `semconv-checker.config.yaml` with `custom_namespaces: [custom]`
  (so the default stack is meaningful and phase-2 assertion 11 passes without a
  QA-supplied config).

### QA

Builds on phase 1 stack. Adds the backend service (compose profile `app`).

#### Folder structure

```
qa/phase-02-backend/
├── docker-compose.test.yml      # include: ../../docker-compose.yml
├── validate.js
└── expected/
    └── report.json               # expected parsed report shape (reference)
```

The repo-root `semconv-checker.config.yaml` already sets `custom_namespaces: [custom]`,
so no QA-supplied config is required for assertion 11. If you want an isolated test
config, add a `backend` volume override in `docker-compose.test.yml` mounting it at
`/app/semconv-checker.config.yaml`.

#### `validate.js` steps

```
1.  [QA] COMPOSE_PROFILES=app docker compose -f docker-compose.test.yml up -d --build
        (UID/GID exported; the `app` profile pulls in the backend)
2.  [QA] Poll GET http://localhost:3001/api/health until 200 (timeout 120s on a
        cold machine — node image pull + npm ci + weaver healthcheck)
3.  [QA] Assert GET http://localhost:3001/api/session -> status === "idle"
4.  [QA] POST http://localhost:3001/api/session/start   (no client timeout — this call
        starts weaver AND restarts the collector; ~10-25s is normal)
5.  [QA] Assert response 200, body.status === "listening"
6.  [QA] POST /api/session/start again -> assert 409
7.  [QA] node ../test-app/index.js --scenario phase-01
8.  [QA] Wait 5s
9.  [QA] POST http://localhost:3001/api/session/stop -> assert 200
10. [QA] Poll GET http://localhost:3001/api/session until status === "report" (timeout 20s)
11. [QA] GET http://localhost:3001/api/report  -> run report assertions
12. [QA] GET http://localhost:3001/api/config  -> assert custom_namespaces == ["custom"]
13. [QA] POST /api/session/start -> assert status "listening"; GET /api/report -> assert 404
14. [QA] COMPOSE_PROFILES=app docker compose -f docker-compose.test.yml down -v --remove-orphans
15. [QA] Print summary, exit 0 or 1
```

#### Assertions — phase 2

| # | Assertion |
|---|-----------|
| 1 | `GET /api/health` returns 200 |
| 2 | `POST /api/session/start` returns 200, status = "listening" |
| 3 | `POST /api/session/start` while listening returns 409 |
| 4 | `GET /api/session` returns status = "report" after stop |
| 5 | `GET /api/report` returns `entities` array and `stats` object |
| 6 | walking `entities` recursively finds at least one `live_check_result.all_advice[]` finding |
| 7 | `stats` contains `registry_coverage`, `advice_type_counts`, `total_entities` |
| 8 | `deprecated` finding for `http.method` present in entities |
| 9 | `required_attribute_not_present` finding for `http.request.method` present in entities |
| 10 | No entities with a `custom.*` signal name in the report |
| 11 | `GET /api/config` returns `custom_namespaces: ["custom"]` |
| 12 | `POST /api/session/start` after report clears previous report and returns to listening |

---